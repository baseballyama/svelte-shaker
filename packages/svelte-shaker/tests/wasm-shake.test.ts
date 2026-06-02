import { join, resolve as resolvePath } from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { buildAnalyzeInput, svelteShaker } from '../src/index';
import { parseSvelte } from '../src/parse';
import { fsReadFile, fsResolve } from '../src/scan';
import { assertCompiles, cleanTmp } from './diff';

afterAll(() => cleanTmp());

// ----------------------------------------------------------------------
// M5 (docs/RUST-MIGRATION.md M5): the transform + emit is now in the Rust→WASM
// engine (`shake_program` = analyze + transform).  This is the end-to-end gate:
// for every fixture graph, the Rust shaker's slimmed output must be BYTE-FOR-BYTE
// identical to the TS `svelteShaker`, and still compile.  Since `svelteShaker`'s
// output is itself the byte-exact golden + differential-SSR-tested reference, a
// byte match means the full Rust engine is sound.
// ----------------------------------------------------------------------

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports
const wasm = require('../engine-rs/pkg/svelte_shaker_engine.js') as {
  shake_program: (inputJson: string) => string;
};

async function rustShake(entry: string): Promise<Record<string, string>> {
  const input = await buildAnalyzeInput(entry, fsResolve, fsReadFile);
  const programInput = {
    files: input.files.map((f) => ({ id: f.id, ast: parseSvelte(f.code, f.id), code: f.code })),
    edges: input.edges,
    entries: input.entries,
  };
  return JSON.parse(wasm.shake_program(JSON.stringify(programInput)));
}

const FIXTURES = resolvePath(__dirname, 'fixtures');

describe('M5: Rust (WASM) shake output is byte-identical to svelteShaker', () => {
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
    it(`${name}: full shaken output matches the TS engine`, async () => {
      const entry = join(FIXTURES, name, 'input', 'App.svelte');
      const viaRust = await rustShake(entry);
      const viaTs = await svelteShaker(entry, fsResolve, fsReadFile);

      expect(viaRust).toEqual(viaTs);
      for (const [id, code] of Object.entries(viaRust)) assertCompiles(code, id);
    });
  }

  it('non-ASCII source: UTF-16 offsets edit correctly (matches the TS engine)', async () => {
    // Multibyte text before/after the folded branch would corrupt a byte-indexed
    // editor; MagicEdit uses UTF-16 units, so it must match svelteShaker exactly.
    const files: Record<string, string> = {
      '/App.svelte': `<script>\n  import Sub from './Sub.svelte';\n</script>\n<Sub />`,
      '/Sub.svelte': `<script>\n  let { hasIcon = false } = $props();\n</script>\n<p>こんにちは🌟</p>\n{#if hasIcon}<p>アイコン</p>{/if}\n<p>さようなら</p>`,
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

    const input = await buildAnalyzeInput('/App.svelte', resolve, readFile);
    const programInput = {
      files: input.files.map((f) => ({ id: f.id, ast: parseSvelte(f.code, f.id), code: f.code })),
      edges: input.edges,
      entries: input.entries,
    };
    const viaRust = JSON.parse(wasm.shake_program(JSON.stringify(programInput)));
    const viaTs = await svelteShaker('/App.svelte', resolve, readFile);
    expect(viaRust).toEqual(viaTs);
    // The dead `{#if}` (アイコン) is gone; the surrounding multibyte text survives intact.
    expect(viaRust['/Sub.svelte']).toContain('こんにちは🌟');
    expect(viaRust['/Sub.svelte']).toContain('さようなら');
    expect(viaRust['/Sub.svelte']).not.toContain('アイコン');
  });
});
