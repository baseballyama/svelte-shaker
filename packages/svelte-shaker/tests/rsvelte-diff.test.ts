import { readdirSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  analyzeInput,
  buildAnalyzeInput,
  svelteShaker,
  transformAll,
  type ReadFile,
  type Resolve,
} from '../src/index';
import type { ParseCache } from '../src/parse';
import { fsReadFile, fsResolve } from '../src/scan';
import { rsvelteParse } from './rsvelte-parse';
import { assertCompiles, cleanTmp, renderHtml } from './diff';

afterAll(() => cleanTmp());

// ----------------------------------------------------------------------
// M3 differential parse oracle (docs/RUST-MIGRATION.md §3): drive the (still-TS)
// analysis + transform with the rsvelte (Rust/OXC) parser instead of
// svelte/compiler, and assert the SAME shaken output.  The ParseCache is the
// parser-injection seam — seed it with rsvelte ASTs and `analyzeInput` consumes
// them; the rest of the engine is byte-for-byte the production path.
//
// This empirically proves the Rust parser can replace svelte/compiler under the
// existing engine: the whole regression corpus shakes byte-for-byte identically
// through either parser.  (rsvelte <= 0.6 returned `TSUnknownKeyword` stubs for
// inline `$props()` type annotations, so a dropped prop's dead type member
// survived and the output byte-differed; 0.7 emits full TS type nodes, closing
// that last divergence.)
// ----------------------------------------------------------------------

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

/** Shake `entries` driving the engine with the rsvelte parser (via the ParseCache
 * seam), instead of svelte/compiler. */
async function shakeWithRsvelte(
  entries: string | string[],
  resolve: Resolve,
  readFile: ReadFile,
): Promise<Record<string, string>> {
  // The crawl parses only to find imports (identical across parsers); the analysis
  // + transform run on the seeded rsvelte ASTs.
  const input = await buildAnalyzeInput(entries, resolve, readFile);
  const cache: ParseCache = new Map();
  for (const f of input.files) cache.set(f.id, { code: f.code, ast: rsvelteParse(f.code) });
  const { models, plans } = analyzeInput(input, cache);
  return transformAll(models, plans);
}

describe('M3: rsvelte parser drives the engine to identical output', () => {
  it('basic fold (never-passed prop) — byte-identical to svelte/compiler', async () => {
    const files = {
      '/App.svelte': `<script>\n  import Sub from './Sub.svelte';\n</script>\n<Sub />`,
      '/Sub.svelte': `<script>\n  let { hasIcon = false } = $props();\n</script>\n{#if hasIcon}<p>Icon</p>{/if}\n<p>base</p>`,
    };
    const { resolve, readFile } = memGraph(files);
    const viaSvelte = await svelteShaker('/App.svelte', resolve, readFile);
    const viaRsvelte = await shakeWithRsvelte('/App.svelte', resolve, readFile);
    expect(viaRsvelte).toEqual(viaSvelte);
    expect(viaRsvelte['/Sub.svelte']).not.toContain('Icon');
  });

  it('value-set narrowing + CSS rule removal — byte-identical', async () => {
    const files = {
      '/App.svelte': `<script>\n  import Btn from './Btn.svelte';\n</script>\n<Btn variant="primary" />\n<Btn variant="secondary" />`,
      '/Btn.svelte': `<script>\n  let { variant = 'primary' } = $props();\n</script>\n{#if variant === 'danger'}<span>danger</span>{/if}\n<button class="btn btn-{variant}">x</button>\n<style>\n  .btn-primary { color: blue; }\n  .btn-danger { color: red; }\n</style>`,
    };
    const { resolve, readFile } = memGraph(files);
    const viaSvelte = await svelteShaker('/App.svelte', resolve, readFile);
    const viaRsvelte = await shakeWithRsvelte('/App.svelte', resolve, readFile);
    expect(viaRsvelte).toEqual(viaSvelte);
    // sanity: the unreachable `danger` arm and its CSS rule were removed
    expect(viaRsvelte['/Btn.svelte']).not.toContain('btn-danger');
    expect(viaRsvelte['/Btn.svelte']).not.toContain('danger');
  });

  it('inline TS-typed dropped prop — byte-identical (rsvelte 0.7 emits full TS type nodes)', async () => {
    const files = {
      '/App.svelte': `<script lang="ts">\n  import Sub from './Sub.svelte';\n</script>\n<Sub />`,
      '/Sub.svelte': `<script lang="ts">\n  let { hasIcon = false }: { hasIcon: boolean } = $props();\n</script>\n{#if hasIcon}<p>Icon</p>{/if}\n<p>base</p>`,
    };
    const { resolve, readFile } = memGraph(files);
    const viaSvelte = await svelteShaker('/App.svelte', resolve, readFile);
    const viaRsvelte = await shakeWithRsvelte('/App.svelte', resolve, readFile);

    // rsvelte 0.7 emits full TS type nodes, so the dead `hasIcon: boolean` type
    // member is stripped exactly like svelte/compiler — the whole program now
    // matches byte-for-byte (the rsvelte <= 0.6 `TSUnknownKeyword` gap is closed).
    expect(viaRsvelte).toEqual(viaSvelte);

    const rSub = viaRsvelte['/Sub.svelte']!;
    expect(rSub).not.toContain('Icon');
    expect(rSub).not.toContain('hasIcon'); // type member stripped, not just folded
    assertCompiles(rSub, '/Sub.svelte');
    expect(await renderHtml(rSub, {}, '/Sub.svelte')).toBe(
      await renderHtml(viaSvelte['/Sub.svelte']!, {}, '/Sub.svelte'),
    );
  });
});

// ----------------------------------------------------------------------
// Corpus-wide sweep: drive EVERY golden fixture with the rsvelte parser and
// compare to the svelte/compiler path file-by-file.  This is the strong M3
// claim — the Rust parser produces byte-for-byte identical shaken output across
// the whole regression corpus (0.7 closed the last inline-TS-type divergence).
// ----------------------------------------------------------------------

const FIXTURES = resolvePath(__dirname, 'fixtures');

describe('M3: rsvelte parser sweep over all golden fixtures', () => {
  const dirs = readdirSync(FIXTURES, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const name of dirs) {
    it(`${name}: rsvelte-driven output is byte-identical to svelte/compiler`, async () => {
      const entry = join(FIXTURES, name, 'input', 'App.svelte');
      const viaSvelte = await svelteShaker(entry, fsResolve, fsReadFile);
      const viaRsvelte = await shakeWithRsvelte(entry, fsResolve, fsReadFile);
      // Whole-program equality subsumes the key-set check and every per-file body.
      expect(viaRsvelte).toEqual(viaSvelte);
    });
  }
});
