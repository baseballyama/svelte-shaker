import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { analyzeInput } from '../src/index';
import { parseSvelte } from '../src/parse';

// ----------------------------------------------------------------------
// M4 first slice (docs/RUST-MIGRATION.md M4): the analysis is being ported to a
// self-contained Rust→WASM core (`engine-rs/`).  Here we validate the first
// ported piece — declared-prop extraction + the `<svelte:options accessors|
// customElement>` whole-component bail — against the TS engine on the SAME AST,
// so it's logic-vs-logic (the Rust walker reproduces analyze.ts exactly).
// ----------------------------------------------------------------------

const require = createRequire(import.meta.url);
// `wasm-pack --target nodejs` output: a CommonJS module that loads the wasm
// synchronously, so it's a plain require with no init dance.
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports
const wasm = require('../engine-rs/pkg/svelte_shaker_engine.js') as {
  analyze_props: (astJson: string) => string;
};

function rustAnalyze(code: string, id: string): { props: string[]; bail: string[] } {
  const astJson = JSON.stringify(parseSvelte(code, id));
  return JSON.parse(wasm.analyze_props(astJson));
}

/** The TS engine's declared-prop names + bail reasons for one component. */
function tsAnalyze(code: string, id: string): { props: string[]; bail: string[] } {
  const { models } = analyzeInput({ files: [{ id, code }], edges: [], entries: [id] });
  const model = models.get(id)!;
  return {
    props: (model.props ?? []).map((p) => p.name),
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
    it(`${label}: declared props + options bail`, () => {
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
});
