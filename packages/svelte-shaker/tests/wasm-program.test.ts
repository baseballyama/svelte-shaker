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
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports
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
async function expectPlansMatch(entry: ComponentId): Promise<void> {
  const input = await buildAnalyzeInput(entry, fsResolve, fsReadFile);
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
    'fold-nested',
    'fold-ternary',
    'if-true',
    'narrow-variant',
    'rest-prop',
    'spread-after',
  ]) {
    it(`${name}: plans (constFold / narrow / valueSets / bail) match`, async () => {
      await expectPlansMatch(join(FIXTURES, name, 'input', 'App.svelte'));
    });
  }
});
