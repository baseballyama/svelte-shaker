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
    'css-dead-branch',
    'css-reverse-only',
    'css-variant',
    'drop-trailing-run',
    'else-empty-consequent',
    'else-exhaustive',
    'fold-alias',
    'fold-local-state',
    'fold-nested',
    'fold-shorthand',
    'fold-ternary',
    'if-true',
    'narrow-variant',
    'narrow-passthrough',
    'rest-prop',
    'spread-after',
    'spread-const-object',
    'unread-declared',
    'unread-guard',
    'unread-input',
    'ws-compensate',
    'ws-kept-arm',
    'ws-pre',
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

  it('TS interface-member keys are not folded (Rust matches the fixed TS engine)', async () => {
    // Mirrors transform-robustness's interface-key guard: the Rust engine's
    // `is_non_reference` must also skip a `TSPropertySignature` key, or it would
    // corrupt `width?: number` -> `36?: number` and diverge from the TS engine.
    const files: Record<string, string> = {
      '/App.svelte': `<script lang="ts">\n  import Child from './Child.svelte';\n</script>\n<Child />`,
      '/Child.svelte': `<script lang="ts">\n  interface Props {\n    width?: number;\n    height?: number;\n  }\n  const { width = 36, height = 20 }: Props = $props();\n</script>\n<p>{width}{height}</p>`,
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
    expect(viaRust['/Child.svelte']).toContain('width?: number');
    expect(viaRust['/Child.svelte']).not.toContain('36?: number');
  });

  it('TS assertions fold in the Rust engine identically to TS (issue #150)', async () => {
    // svelte/compiler keeps `'chips' as const` / `8 as const` as TS assertion nodes,
    // so the Rust engine sees them too. Its evaluator (call-site value) and its
    // `literal_default` (never-passed default) must both read through the erased
    // assertion exactly like the TS engine, or the two byte-diverge on `lang="ts"`
    // apps. `pattern` folds from the call site; `size` folds from its `as const`
    // default (never passed).
    const files: Record<string, string> = {
      '/App.svelte': `<script lang="ts">\n  import Child from './Child.svelte';\n</script>\n<Child pattern={'chips' as const} />`,
      '/Child.svelte':
        `<script lang="ts">\n  let { pattern, size = 8 as const } = $props();\n</script>\n` +
        `{#if pattern === 'text'}<em>t</em>{/if}\n{#if pattern === 'chips'}<b>c</b>{/if}\n` +
        `{#if size === 8}<i>eight</i>{/if}`,
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
    const viaRust = JSON.parse(wasm.shake_program(JSON.stringify(programInput))) as Record<
      string,
      string
    >;
    const viaTs = await svelteShaker('/App.svelte', resolve, readFile);
    expect(viaRust).toEqual(viaTs);
    for (const [id, code] of Object.entries(viaRust)) assertCompiles(code, id);
    const child = viaRust['/Child.svelte']!;
    expect(child).toContain('<b>c</b>'); // pattern folded from the call site
    expect(child).toContain('<i>eight</i>'); // size folded from its `as const` default
    expect(child).not.toContain('<em>'); // dead `pattern === 'text'` arm removed
    expect(child).not.toContain('pattern'); // both props dropped from the signature
  });

  it('a write through `x!++` is counted in the Rust engine too (issue #150 review)', async () => {
    // `count!++` keeps the `!` as a `TSNonNullExpression` around the target, so the
    // Rust write-collection must read through it or it admits `count` as a constant
    // and folds a stale `0` into `<C n={count}/>` — diverging from the (fixed) TS
    // engine. Written -> nothing folds, so both engines emit the input unchanged.
    const files: Record<string, string> = {
      '/App.svelte': `<script lang="ts">\n  import C from './C.svelte';\n  let count = $state(0);\n  function inc() { count!++; }\n</script>\n<C n={count} />\n<button onclick={inc}>+</button>`,
      '/C.svelte': `<script lang="ts">\n  let { n } = $props();\n</script>\n{#if n === 0}<b>zero</b>{:else}<i>{n}</i>{/if}`,
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
    const viaRust = JSON.parse(wasm.shake_program(JSON.stringify(programInput))) as Record<
      string,
      string
    >;
    const viaTs = await svelteShaker('/App.svelte', resolve, readFile);
    expect(viaRust).toEqual(viaTs);
    // `count` is written, so `n` never folds: both `{#if}` arms survive.
    expect(viaRust['/C.svelte']).toContain('zero');
    expect(viaRust['/C.svelte']).toContain('{n}');
  });

  it('interprocedural pass-through: a forwarded folded prop matches the TS engine', async () => {
    // App -> Mid -> Child: `variant` folds in Mid, so the forwarded
    // `<Child variant={variant}/>` must fold in Child too and its attribute be
    // removed. The Rust fixpoint's owner-env evaluation must match the TS engine
    // byte-for-byte (docs §13.1) — including a ternary and a pure-literal forward.
    const files: Record<string, string> = {
      '/App.svelte': `<script>\n  import Mid from './Mid.svelte';\n</script>\n<Mid variant="primary" />`,
      '/Mid.svelte':
        `<script>\n  import Child from './Child.svelte';\n  import Leaf from './Leaf.svelte';\n  let { variant } = $props();\n</script>\n` +
        `<Child variant={variant} />\n<Leaf k={variant === 'primary' ? 'x' : 'y'} m={'a' + 'b'} />`,
      '/Child.svelte':
        `<script>\n  let { variant = 'other' } = $props();\n</script>\n` +
        `{#if variant === 'primary'}<b>P</b>{:else}<i>o</i>{/if}`,
      '/Leaf.svelte':
        `<script>\n  let { k = 'z', m = 'z' } = $props();\n</script>\n` +
        `{#if k === 'x'}<b>X</b>{/if}{#if m === 'ab'}<b>AB</b>{/if}`,
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
    const viaRust = JSON.parse(wasm.shake_program(JSON.stringify(programInput))) as Record<
      string,
      string
    >;
    const viaTs = await svelteShaker('/App.svelte', resolve, readFile);
    expect(viaRust).toEqual(viaTs);
    for (const [id, code] of Object.entries(viaRust)) assertCompiles(code, id);
    // The pass-through actually fired (both engines agree on this, above).
    expect(viaRust['/Child.svelte']).not.toMatch(/let \{ variant/);
    expect(viaRust['/Mid.svelte']).not.toContain('variant=');
    expect(viaRust['/Leaf.svelte']).not.toMatch(/let \{ k/);
  });

  it('deep pass-through chain: leaf fold matches the TS engine past the old cap', async () => {
    // A 14-stage forwarding chain needs more propagation rounds than the old fixed
    // cap of 10. Both engines scale the fixpoint bound with the component count, so
    // the deepest fold (S14) must reach the leaf identically — byte-for-byte.
    const files: Record<string, string> = {
      '/App.svelte': `<script>\n  import S1 from './S1.svelte';\n</script>\n<S1 v="go" />\n`,
    };
    for (let k = 1; k < 14; k++) {
      files[`/S${k}.svelte`] =
        `<script>\n  import S${k + 1} from './S${k + 1}.svelte';\n  let { v } = $props();\n</script>\n` +
        `<S${k + 1} v={v} />\n`;
    }
    files['/S14.svelte'] =
      `<script>\n  let { v = 'stop' } = $props();\n</script>\n` +
      `{#if v === 'go'}<b>GO</b>{:else}<i>stop</i>{/if}\n`;
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
    const viaRust = JSON.parse(wasm.shake_program(JSON.stringify(programInput))) as Record<
      string,
      string
    >;
    const viaTs = await svelteShaker('/App.svelte', resolve, readFile);
    expect(viaRust).toEqual(viaTs);
    for (const [id, code] of Object.entries(viaRust)) assertCompiles(code, id);
    // The fold reached the leaf in both engines: dead arm gone, prop dropped.
    expect(viaRust['/S14.svelte']).toContain('<b>GO</b>');
    expect(viaRust['/S14.svelte']).not.toContain('stop</i>');
    expect(viaRust['/S14.svelte']).not.toMatch(/let \{ v/);
  });
});
