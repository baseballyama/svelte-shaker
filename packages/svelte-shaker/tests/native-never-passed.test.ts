import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildAnalyzeInput, findNeverPassedProps } from '../src/index';
import type { ReadFile, Resolve, UnpassedProp } from '../src/index';

// The native (napi) scanner must match the TS `findNeverPassedProps` on the same
// program — name AND span, byte-for-byte. The native path parses with rsvelte and
// runs the validated engine in-process; this differential test is the soundness
// pin for `engine-scan-native`, the napi twin of `wasm-never-passed.test.ts`.
const require = createRequire(import.meta.url);
const addonPath = fileURLToPath(new URL('../engine-scan-native/index.cjs', import.meta.url));
const dylib = fileURLToPath(
  new URL(
    `../engine-scan-native/target/debug/${
      process.platform === 'darwin'
        ? 'libsvelte_shaker_engine_scan_native.dylib'
        : process.platform === 'win32'
          ? 'svelte_shaker_engine_scan_native.dll'
          : 'libsvelte_shaker_engine_scan_native.so'
    }`,
    import.meta.url,
  ),
);

interface NativeScanner {
  scan: (inputJson: string) => string;
  scanViaValue: (inputJson: string) => string;
}
// Skip (do not fail) when the addon has not been built — CI builds it first; a
// bare `pnpm test` on a fresh checkout without a cargo build should not be red.
const addon: NativeScanner | null = existsSync(dylib)
  ? (require(addonPath) as NativeScanner)
  : null;

const resolve: Resolve = (source, importer) =>
  source.startsWith('.') ? new URL(source, `file://${importer}`).pathname : null;

type Reported = { name: string; start: number; end: number };

function byFile(entries: Iterable<[string, UnpassedProp[]]>): Record<string, Reported[]> {
  const out: Record<string, Reported[]> = {};
  for (const [id, props] of entries) {
    out[id] = [...props]
      .map((p) => ({ name: p.name, start: p.start, end: p.end }))
      .sort((a, b) => a.start - b.start || a.name.localeCompare(b.name));
  }
  return out;
}

async function bothEngines(files: Record<string, string>): Promise<{
  js: Record<string, Reported[]>;
  native: Record<string, Reported[]>;
}> {
  const readFile: ReadFile = (id) => files[id]!;
  const entries = Object.keys(files).filter((f) => f.endsWith('.svelte'));
  const input = await buildAnalyzeInput(entries, resolve, readFile);

  const js = byFile(findNeverPassedProps(input));

  const payload = JSON.stringify({ files: input.files, edges: input.edges });
  const native = byFile(
    Object.entries(JSON.parse(addon!.scan(payload)) as Record<string, UnpassedProp[]>),
  );
  // The typed scan must also match its own Value-engine oracle byte-for-byte.
  const oracle = byFile(
    Object.entries(JSON.parse(addon!.scanViaValue(payload)) as Record<string, UnpassedProp[]>),
  );
  expect(native).toEqual(oracle);

  return { js, native };
}

describe.skipIf(!addon)('native find_never_passed_props matches the TS engine', () => {
  it('basic / escaped / entry program', async () => {
    const { js, native } = await bothEngines({
      '/App.svelte': [
        "<script>import Child from './Child.svelte';</script>",
        '<Child a={1} />',
      ].join('\n'),
      '/Child.svelte': '<script>let { a, b } = $props();</script>\n{a}{b}',
      '/Esc.svelte': [
        "<script>import C from './Leaf.svelte';\n  const X = C;</script>",
        '<svelte:component this={X} />',
      ].join('\n'),
      '/Leaf.svelte': '<script>let { p, q } = $props();</script>\n{p}{q}',
      '/Page.svelte': '<script>let { data } = $props();</script>\n{data}',
    });
    expect(native).toEqual(js);
    expect(Object.keys(js)).toEqual(['/Child.svelte']);
    expect(js['/Child.svelte']!.map((p) => p.name)).toEqual(['b']);
  });

  it('bind: / spread / body all count as passed', async () => {
    const { js, native } = await bothEngines({
      '/App.svelte': [
        "<script>import Box from './Box.svelte';\n  let v = $state('');</script>",
        '<Box attr="x" bind:bound={v}>body{#snippet head()}h{/snippet}</Box>',
      ].join('\n'),
      '/Box.svelte':
        '<script>let { attr, bound = $bindable(), children, head, dead } = $props();</script>\n{attr}{bound}{@render head?.()}{@render children?.()}{dead}',
    });
    expect(native).toEqual(js);
    expect(js['/Box.svelte']!.map((p) => p.name)).toEqual(['dead']);
  });

  it('rename (prop: alias) reports the external name; namespace + barrel edges', async () => {
    const { js, native } = await bothEngines({
      '/App.svelte': [
        "<script>import { Btn } from './ui.js';\n  import * as ns from './ui.js';</script>",
        '<Btn label="x" /><ns.Card />',
      ].join('\n'),
      '/ui.js':
        "export { default as Btn } from './Btn.svelte';\nexport { default as Card } from './Card.svelte';",
      // `size` declared with an alias and never passed -> reported by external name.
      '/Btn.svelte': '<script>let { label, size: s = 1 } = $props();</script>\n{label}{s}',
      '/Card.svelte': '<script>let { title } = $props();</script>\n{title}',
    });
    expect(native).toEqual(js);
  });

  it('non-ASCII source: spans stay UTF-16 and match the JS engine', async () => {
    const { js, native } = await bothEngines({
      '/App.svelte': ["<script>import Lbl from './Lbl.svelte';</script>", '<Lbl text="あ" />'].join(
        '\n',
      ),
      // The comment uses astral + multibyte chars BEFORE the prop, so a UTF-8
      // byte offset would disagree with ESLint's UTF-16 index unless remapped.
      '/Lbl.svelte':
        '<script>\n  // 日本語コメント 𠮷野家 — multibyte before props\n  let { text, hidden } = $props();\n</script>\n{text}{hidden}',
    });
    expect(native).toEqual(js);
    expect(js['/Lbl.svelte']!.map((p) => p.name)).toEqual(['hidden']);
  });

  it('spread at call site keeps every prop (top), reports nothing', async () => {
    const { js, native } = await bothEngines({
      '/App.svelte': [
        "<script>import Row from './Row.svelte';\n  const rest = { x: 1 };</script>",
        '<Row {...rest} />',
      ].join('\n'),
      '/Row.svelte': '<script>let { x, y } = $props();</script>\n{x}{y}',
    });
    expect(native).toEqual(js);
    expect(js).toEqual({});
  });
});
