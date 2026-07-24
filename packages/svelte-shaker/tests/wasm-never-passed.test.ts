import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { buildAnalyzeInput, findNeverPassedProps } from '../src/index';
import type { ReadFile, Resolve } from '../src/index';
import { parseSvelte } from '../src/parse';

// The Rust/WASM `find_never_passed_props_json` must match the TS
// `findNeverPassedProps` on the same svelte AST — logic-vs-logic, the foundation
// for the native (napi) scan path.
const require = createRequire(import.meta.url);
const wasm = require('../engine-rs/pkg/svelte_shaker_engine.js') as {
  find_never_passed_props_json: (inputJson: string) => string;
};

const resolve: Resolve = (source, importer) =>
  source.startsWith('.') ? new URL(source, `file://${importer}`).pathname : null;

function namesByFile(entries: Iterable<[string, { name: string }[]]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [id, props] of entries) out[id] = props.map((p) => p.name).sort();
  return out;
}

async function bothEngines(files: Record<string, string>): Promise<{
  js: Record<string, string[]>;
  rust: Record<string, string[]>;
}> {
  const readFile: ReadFile = (id) => files[id]!;
  const entries = Object.keys(files).filter((f) => f.endsWith('.svelte'));
  const input = await buildAnalyzeInput(entries, resolve, readFile);

  const js = findNeverPassedProps(input);

  const programInput = {
    files: input.files.map((f) => ({ id: f.id, ast: parseSvelte(f.code, f.id) })),
    edges: input.edges,
    entries: input.entries,
  };
  const rust = JSON.parse(
    wasm.find_never_passed_props_json(JSON.stringify(programInput)),
  ) as Record<string, { name: string; start: number; end: number }[]>;

  return { js: namesByFile(js), rust: namesByFile(Object.entries(rust)) };
}

describe('WASM find_never_passed_props matches the TS engine', () => {
  it('basic / escaped / entry program', async () => {
    const { js, rust } = await bothEngines({
      '/App.svelte': [
        "<script>import Child from './Child.svelte';</script>",
        '<Child a={1} />',
      ].join('\n'),
      // `a` is passed, `b` never -> reported in both engines.
      '/Child.svelte': '<script>let { a, b } = $props();</script>\n{a}{b}',
      // Escaped as a value -> skipped in both.
      '/Esc.svelte': [
        "<script>import C from './Leaf.svelte';\n  const X = C;</script>",
        '<svelte:component this={X} />',
      ].join('\n'),
      '/Leaf.svelte': '<script>let { p, q } = $props();</script>\n{p}{q}',
      // Zero call sites (entry) -> skipped in both.
      '/Page.svelte': '<script>let { data } = $props();</script>\n{data}',
    });
    expect(rust).toEqual(js);
    expect(js).toEqual({ '/Child.svelte': ['b'] });
  });

  it('bind: / spread / body all count as passed', async () => {
    const { js, rust } = await bothEngines({
      '/App.svelte': [
        "<script>import Box from './Box.svelte';\n  let v = $state('');</script>",
        '<Box attr="x" bind:bound={v}>body{#snippet head()}h{/snippet}</Box>',
      ].join('\n'),
      '/Box.svelte':
        '<script>let { attr, bound = $bindable(), children, head, dead } = $props();</script>\n{attr}{bound}{@render head?.()}{@render children?.()}{dead}',
    });
    expect(rust).toEqual(js);
    expect(js).toEqual({ '/Box.svelte': ['dead'] });
  });
});
