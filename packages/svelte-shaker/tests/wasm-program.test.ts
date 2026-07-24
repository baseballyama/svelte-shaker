import { join, resolve as resolvePath } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { analyzeInput, buildAnalyzeInput, type ComponentId } from '../src/index';
import { parseSvelte } from '../src/parse';
import { fsReadFile, fsResolve } from '../src/scan';
import type { ComponentPlan, Literal, PropValueSet } from '../src/ir';

// ----------------------------------------------------------------------
// M4 whole-program slice (docs/RUST-MIGRATION.md M4): the value-set lattice join,
// the fixpoint cascade, the partial bail, and dead-span folding are now in the
// Rust→WASM engine (`analyze_program`).  This is the all-in-one validation: drive
// every fixture's real graph through BOTH engines and assert the full `plans`
// (constFold / narrow / valueSets / bail / reasons) match — Rust-vs-TS on the same
// svelte AST, so it's logic-vs-logic across the whole analysis.
// ----------------------------------------------------------------------

const require = createRequire(import.meta.url);
const wasm = require('../engine-rs/pkg/svelte_shaker_engine.js') as {
  analyze_program: (inputJson: string) => string;
};

/** Encode a literal so `undefined` stays distinct from `null` across JSON (the
 * Rust side emits the same `{$undefined:true}` sentinel). */
function enc(v: Literal): unknown {
  return v === undefined ? { $undefined: true } : v;
}

interface PlanJson {
  id: string;
  bail: boolean;
  reasons: string[];
  constFold: Record<string, unknown>;
  narrow: Record<string, unknown[]>;
  valueSets: Record<string, { values: unknown[]; dynamic: boolean; top: boolean }>;
}

function tsPlanJson(plan: ComponentPlan): PlanJson {
  const valueSets: PlanJson['valueSets'] = {};
  for (const [k, s] of plan.valueSets as Map<string, PropValueSet>) {
    valueSets[k] = { values: s.values.map(enc), dynamic: s.dynamic, top: s.top };
  }
  return {
    id: plan.id,
    bail: plan.bail,
    reasons: [...plan.reasons].sort(),
    constFold: Object.fromEntries([...plan.constFold].map(([k, v]) => [k, enc(v)])),
    narrow: Object.fromEntries([...plan.narrow].map(([k, vs]) => [k, vs.map(enc)])),
    valueSets,
  };
}

function normalizeRust(plan: PlanJson): PlanJson {
  return { ...plan, reasons: [...plan.reasons].sort() };
}

/** Run both engines on a fixture graph and assert the plans match per component. */
async function expectPlansMatch(
  entry: ComponentId,
  resolve = fsResolve,
  readFile = fsReadFile,
): Promise<void> {
  const input = await buildAnalyzeInput(entry, resolve, readFile);
  const programInput = {
    files: input.files.map((f) => ({ id: f.id, ast: parseSvelte(f.code, f.id) })),
    edges: input.edges,
    entries: input.entries,
  };
  const rustPlans = JSON.parse(wasm.analyze_program(JSON.stringify(programInput))) as Record<
    string,
    PlanJson
  >;
  const { plans } = analyzeInput(input);

  expect(Object.keys(rustPlans).sort()).toEqual([...plans.keys()].sort());
  for (const [id, plan] of plans) {
    expect(normalizeRust(rustPlans[id]!), id).toEqual(tsPlanJson(plan));
  }
}

const FIXTURES = resolvePath(__dirname, 'fixtures');

describe('M4: Rust (WASM) whole-program plans match the TS engine', () => {
  for (const name of [
    'basic1',
    'cascade',
    'css-variant',
    'drop-trailing-run',
    'fold-alias',
    'fold-nested',
    'fold-shorthand',
    'fold-ternary',
    'if-true',
    'narrow-variant',
    'narrow-passthrough',
    'rest-prop',
    'spread-after',
    'spread-const-object',
    'ws-compensate',
    'ws-kept-arm',
    'ws-pre',
  ]) {
    it(`${name}: plans (constFold / narrow / valueSets / bail) match`, async () => {
      await expectPlansMatch(join(FIXTURES, name, 'input', 'App.svelte'));
    });
  }

  it('interprocedural pass-through: forwarded-prop plans match (docs §13.1)', async () => {
    // The owner-env fixpoint evaluation (a forwarded `variant={variant}`, a ternary,
    // and a pure-literal forward) must produce identical plans in both engines.
    const files: Record<string, string> = {
      '/App.svelte': `<script>\n  import Mid from './Mid.svelte';\n</script>\n<Mid variant="primary" />`,
      '/Mid.svelte':
        `<script>\n  import Child from './Child.svelte';\n  import Leaf from './Leaf.svelte';\n  let { variant } = $props();\n</script>\n` +
        `<Child variant={variant} />\n<Leaf k={variant === 'primary' ? 'x' : 'y'} m={'a' + 'b'} />`,
      '/Child.svelte': `<script>\n  let { variant = 'other' } = $props();\n</script>\n{#if variant === 'primary'}<b>P</b>{:else}<i>o</i>{/if}`,
      '/Leaf.svelte': `<script>\n  let { k = 'z', m = 'z' } = $props();\n</script>\n{#if k === 'x'}<b>X</b>{/if}{#if m === 'ab'}<b>AB</b>{/if}`,
    };
    const resolve = (source: string, importer: string): string | null => {
      if (!source.startsWith('.')) return null;
      const base = importer.slice(0, importer.lastIndexOf('/'));
      const parts: string[] = [];
      for (const seg of `${base}/${source}`.split('/')) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') parts.pop();
        else parts.push(seg);
      }
      return `/${parts.join('/')}`;
    };
    const readFile = (id: string): string => files[id]!;
    await expectPlansMatch('/App.svelte', resolve, readFile);
  });

  it('interprocedural set pass-through: forwarded NARROW-set plans match (docs §13.1, PR6)', async () => {
    // A bare forwarded owner-prop that the owner NARROWED to a set must flow the
    // whole set into the child in both engines; a compound expression over the
    // set-var must NOT (stays dynamic).  Same owner-env fixpoint, so the plans
    // (Child narrows, Leaf stays dynamic) must be byte-identical Rust-vs-TS.
    const files: Record<string, string> = {
      '/App.svelte': `<script>\n  import Mid from './Mid.svelte';\n</script>\n<Mid variant="primary" />\n<Mid variant="secondary" />`,
      '/Mid.svelte':
        `<script>\n  import Child from './Child.svelte';\n  import Leaf from './Leaf.svelte';\n  let { variant } = $props();\n</script>\n` +
        `<Child variant={variant} />\n<Leaf k={variant + ''} />`,
      '/Child.svelte': `<script>\n  let { variant = 'other' } = $props();\n</script>\n{#if variant === 'danger'}<b>D</b>{/if}`,
      '/Leaf.svelte': `<script>\n  let { k = 'z' } = $props();\n</script>\n{#if k === 'x'}<b>X</b>{/if}`,
    };
    const resolve = (source: string, importer: string): string | null => {
      if (!source.startsWith('.')) return null;
      const base = importer.slice(0, importer.lastIndexOf('/'));
      const parts: string[] = [];
      for (const seg of `${base}/${source}`.split('/')) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') parts.pop();
        else parts.push(seg);
      }
      return `/${parts.join('/')}`;
    };
    const readFile = (id: string): string => files[id]!;
    await expectPlansMatch('/App.svelte', resolve, readFile);
  });
});
