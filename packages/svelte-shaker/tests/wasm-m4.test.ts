import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { analyzeInput } from '../src/index';
import { parseSvelte } from '../src/parse';

// ----------------------------------------------------------------------
// M4 (docs/RUST-MIGRATION.md M4): the analysis is being ported to a
// self-contained Rust→WASM core (`engine-rs/`), one slice at a time.  Each ported
// piece is validated against the TS engine on the SAME AST, so it's logic-vs-logic
// (the Rust walker reproduces analyze.ts exactly).  Ported so far: declared props,
// `...rest` presence, the shadowed / `{@debug}` fold-blocking name sets
// (collectTemplateBindings), and the `<svelte:options>` bail.
// ----------------------------------------------------------------------

const require = createRequire(import.meta.url);
// `wasm-pack --target nodejs` output: a CommonJS module that loads the wasm
// synchronously, so it's a plain require with no init dance.
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports
const wasm = require('../engine-rs/pkg/svelte_shaker_engine.js') as {
  analyze_component: (astJson: string) => string;
};

interface ComponentFacts {
  props: string[];
  hasRestProp: boolean;
  shadowed: string[];
  debug: string[];
  bail: string[];
}

function rustAnalyze(code: string, id: string): ComponentFacts {
  const astJson = JSON.stringify(parseSvelte(code, id));
  return JSON.parse(wasm.analyze_component(astJson));
}

/** The same per-file model facts as the TS engine computes for one component. */
function tsAnalyze(code: string, id: string): ComponentFacts {
  const { models } = analyzeInput({ files: [{ id, code }], edges: [], entries: [id] });
  const model = models.get(id)!;
  return {
    props: (model.props ?? []).map((p) => p.name),
    hasRestProp: model.hasRestProp,
    shadowed: [...model.shadowedNames].sort(),
    debug: [...model.debugNames].sort(),
    // The Rust slice covers only the accessors/customElement bail so far.
    bail: model.bailReasons.filter((r) => r.startsWith('<svelte:options')),
  };
}

const FIXTURES = resolvePath(__dirname, 'fixtures');

/** Every `.svelte` component across all fixtures' `input/` dirs. */
function fixtureComponents(): Array<{ id: string; code: string }> {
  const out: Array<{ id: string; code: string }> = [];
  for (const name of readdirSync(FIXTURES, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const inputDir = join(FIXTURES, name.name, 'input');
    let files: string[];
    try {
      files = readdirSync(inputDir).filter((f) => f.endsWith('.svelte'));
    } catch {
      continue;
    }
    for (const f of files)
      out.push({ id: join(inputDir, f), code: readFileSync(join(inputDir, f), 'utf-8') });
  }
  return out;
}

describe('M4: Rust (WASM) analysis slice matches the TS engine', () => {
  for (const { id, code } of fixtureComponents()) {
    const label = id.slice(FIXTURES.length + 1);
    it(`${label}: props / rest / shadowed / debug / bail`, () => {
      expect(rustAnalyze(code, id)).toEqual(tsAnalyze(code, id));
    });
  }

  it('a `<svelte:options accessors />` component analyzes identically to the TS engine', () => {
    // NOTE: the Rust slice is a FAITHFUL port of analyze.ts, which walks
    // `ast.fragment` for a `SvelteOptions` node.  On the current svelte/compiler
    // AST the `<svelte:options>` lands at `root.options` (no `SvelteOptions`-typed
    // node in `fragment`), so NEITHER engine currently flags the bail here — a
    // pre-existing gap to address on its own, not in this parser-port slice.  The
    // point of M4 is that the Rust analysis reproduces the TS analysis exactly:
    const code = `<svelte:options accessors />\n<script>\n  let { x = 1 } = $props();\n</script>\n<p>{x}</p>`;
    const r = rustAnalyze(code, '/A.svelte');
    expect(r.props).toEqual(['x']);
    expect(r).toEqual(tsAnalyze(code, '/A.svelte'));
  });

  it('collects every binder kind on a real Svelte AST identically to the TS engine', () => {
    // Exercises each `collectTemplateBindings` path against the actual parser:
    // destructured `{#each as}` + index, `{@const}`, `{#snippet name(params)}`,
    // `{:then}`/`{:catch}`, `let:`, `{@debug}`, and an instance function's params.
    const code = [
      `<script>`,
      `  let { variant } = $props();`,
      `  function handle(evt, ctx) { return evt; }`,
      `  const arr = [1];`,
      `</script>`,
      `{#each arr as { id }, i}<p>{id}{i}</p>{/each}`,
      `{#snippet row(p, q)}<span>{p}{q}</span>{/snippet}`,
      `{#await arr then value}<i>{value}</i>{:catch err}<b>{err}</b>{/await}`,
      `{@const doubled = variant}`,
      `{@debug variant}`,
    ].join('\n');
    expect(rustAnalyze(code, '/B.svelte')).toEqual(tsAnalyze(code, '/B.svelte'));
  });
});
