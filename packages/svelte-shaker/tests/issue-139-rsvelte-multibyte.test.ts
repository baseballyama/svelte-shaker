import { afterAll, describe, expect, it } from 'vitest';
import { svelteShaker, type ReadFile, type Resolve } from '../src/index';
import { tryLoadRsvelteParser } from '../src/rsvelte-parse';
import { assertCompiles, cleanTmp, renderHtml } from './diff';

afterAll(() => cleanTmp());

// ----------------------------------------------------------------------
// Regression: issue #139 — the rsvelte parser reports positions as UTF-8 *byte*
// offsets, but the engine's transform drives `magic-string` with UTF-16
// code-unit offsets. A multibyte character *before* a spliced range shifts every
// later byte offset past its UTF-16 index, so a raw rsvelte AST made the
// transform cut at the wrong place: a `MagicString: end is out of bounds` crash
// when the drift is large, or — more dangerously — silent output corruption when
// it is small. The parser must remap byte offsets to UTF-16 before the engine
// sees them, so the rsvelte path is byte-identical to the svelte/compiler path.
// ----------------------------------------------------------------------

const rsvelte = tryLoadRsvelteParser();

/** Minimal in-memory module graph (POSIX-style absolute ids). */
function memGraph(files: Record<string, string>): { resolve: Resolve; readFile: ReadFile } {
  const resolve: Resolve = (source, importer) => {
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
  const readFile: ReadFile = (id) => {
    const code = files[id];
    if (code === undefined) throw new Error(`no such file: ${id}`);
    return code;
  };
  return { resolve, readFile };
}

/** Shake `files` from `/App.svelte` with BOTH parsers and assert byte-identity,
 * that the rsvelte residual compiles, and that it server-renders identically. */
async function expectRsvelteMatchesSvelte(files: Record<string, string>): Promise<void> {
  const { resolve, readFile } = memGraph(files);
  const viaSvelte = await svelteShaker('/App.svelte', resolve, readFile);
  const viaRsvelte = await svelteShaker('/App.svelte', resolve, readFile, rsvelte!);
  // The whole shaken program must be byte-for-byte identical across parsers.
  expect(viaRsvelte).toEqual(viaSvelte);
  for (const [id, code] of Object.entries(viaRsvelte)) assertCompiles(code, id);
}

describe('issue #139: rsvelte multibyte offset remap', () => {
  it.skipIf(!rsvelte)(
    'large drift: multibyte text before a removed block does not crash and matches svelte',
    async () => {
      // Many multibyte characters before the deleted `{#if loading}` block push
      // its byte offset far past its UTF-16 index — the large-drift case that
      // crashed with `MagicString: end is out of bounds` before the fix.
      const files = {
        '/App.svelte': `<script>\n  import C from './C.svelte';\n</script>\n<C />`,
        '/C.svelte':
          `<script>\n  let { loading = false } = $props();\n</script>\n` +
          `<p>これはとても長い日本語のテキストで、マルチバイト文字がたくさん含まれています。</p>\n` +
          `{#if loading}<span>読み込み中です</span>{/if}\n<p>base</p>`,
      };
      await expectRsvelteMatchesSvelte(files);
    },
  );

  it.skipIf(!rsvelte)(
    'small drift: one multibyte char before a removed block stays byte-identical (no silent corruption)',
    async () => {
      // A single multibyte character before the deleted block shifts offsets by
      // just two bytes — too small to crash, so before the fix it silently spliced
      // one code unit off, corrupting the output without any error.
      const files = {
        '/App.svelte': `<script>\n  import C from './C.svelte';\n</script>\n<C />`,
        '/C.svelte':
          `<script>\n  let { loading = false } = $props();\n</script>\n` +
          `<p>あ</p>\n{#if loading}<span>x</span>{/if}\n<p>base</p>`,
      };
      await expectRsvelteMatchesSvelte(files);
    },
  );

  it.skipIf(!rsvelte)('the multibyte text survives and the dead branch is gone', async () => {
    const files = {
      '/App.svelte': `<script>\n  import C from './C.svelte';\n</script>\n<C />`,
      '/C.svelte':
        `<script>\n  let { loading = false } = $props();\n</script>\n` +
        `<p>日本語テキストです</p>\n{#if loading}<span>読み込み中</span>{/if}\n<p>base</p>`,
    };
    const { resolve, readFile } = memGraph(files);
    const viaRsvelte = await svelteShaker('/App.svelte', resolve, readFile, rsvelte!);
    const shaken = viaRsvelte['/C.svelte']!;
    expect(shaken).toContain('<p>日本語テキストです</p>'); // preserved intact
    expect(shaken).not.toContain('読み込み中'); // dead branch removed
    expect(shaken).not.toMatch(/\{#if loading\}/);

    // Soundness: for the value that actually occurs (loading=false) the rendered
    // HTML is identical before and after shaking.
    const before = await renderHtml(files['/C.svelte'], { loading: false }, '/C.svelte');
    const after = await renderHtml(shaken, {}, '/C.svelte');
    expect(after).toBe(before);
  });
});
