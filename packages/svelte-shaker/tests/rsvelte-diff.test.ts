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
// existing engine (the first concrete Rust-port step) and pins the ONE known
// divergence in rsvelte@0.6.1: inline TS type annotations come back as
// `TSUnknownKeyword` stubs (no `members`), so the dead type member of a dropped
// prop is not stripped.  That residual is TS — erased at compile — so it is
// SSR-equivalent; it is the documented blocker before rsvelte can become the
// default parser (track upstream: emit full TS type nodes).
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

  it('KNOWN GAP: inline TS-typed dropped prop — SSR-equivalent (byte differs by dead type text)', async () => {
    const files = {
      '/App.svelte': `<script lang="ts">\n  import Sub from './Sub.svelte';\n</script>\n<Sub />`,
      '/Sub.svelte': `<script lang="ts">\n  let { hasIcon = false }: { hasIcon: boolean } = $props();\n</script>\n{#if hasIcon}<p>Icon</p>{/if}\n<p>base</p>`,
    };
    const { resolve, readFile } = memGraph(files);
    const viaSvelte = await svelteShaker('/App.svelte', resolve, readFile);
    const viaRsvelte = await shakeWithRsvelte('/App.svelte', resolve, readFile);

    const sSub = viaSvelte['/Sub.svelte']!;
    const rSub = viaRsvelte['/Sub.svelte']!;

    // Both fold the dead branch identically — the divergence is ONLY the residual
    // TS type member (svelte strips `hasIcon: boolean`; rsvelte@0.6.1 cannot yet).
    expect(rSub).not.toContain('Icon');
    expect(sSub).not.toContain('hasIcon'); // svelte removed the type member too

    // Behaviorally identical: the residual type is erased at compile, so the
    // server-rendered HTML matches, and the rsvelte-shaken output still compiles.
    assertCompiles(rSub, '/Sub.svelte');
    const rHtml = await renderHtml(rSub, {}, '/Sub.svelte');
    const sHtml = await renderHtml(sSub, {}, '/Sub.svelte');
    expect(rHtml).toBe(sHtml);
  });
});

// ----------------------------------------------------------------------
// Corpus-wide sweep: drive EVERY golden fixture with the rsvelte parser and
// compare to the svelte/compiler path file-by-file.  This is the strong M3
// claim — the Rust parser produces identical shaken output across the whole
// regression corpus, with divergences confined to (and explained by) rsvelte's
// known TS-type-node gap, and every rsvelte-driven output still compiles.
// ----------------------------------------------------------------------

const FIXTURES = resolvePath(__dirname, 'fixtures');

/** Fixtures whose shaken output is expected to byte-differ ONLY because a dropped
 * prop's inline TS type member survives (rsvelte@0.6.1 emits `TSUnknownKeyword`
 * for it). These must still compile and stay behaviorally identical. */
const KNOWN_TS_GAP = new Set(['rest-prop', 'spread-after']);

describe('M3: rsvelte parser sweep over all golden fixtures', () => {
  const dirs = readdirSync(FIXTURES, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const name of dirs) {
    it(`${name}: rsvelte-driven output matches svelte (modulo the known TS gap)`, async () => {
      const entry = join(FIXTURES, name, 'input', 'App.svelte');
      const viaSvelte = await svelteShaker(entry, fsResolve, fsReadFile);
      const viaRsvelte = await shakeWithRsvelte(entry, fsResolve, fsReadFile);

      expect(Object.keys(viaRsvelte).sort()).toEqual(Object.keys(viaSvelte).sort());

      const diverged: string[] = [];
      for (const id of Object.keys(viaSvelte)) {
        if (viaRsvelte[id] === viaSvelte[id]) continue;
        diverged.push(id);
        // A divergence is only acceptable if the rsvelte output is still valid
        // Svelte (the residual is dead, compile-erased TS type text).
        assertCompiles(viaRsvelte[id]!, id);
      }

      if (KNOWN_TS_GAP.has(name)) {
        // Expected to diverge on at least one file (the inline-typed component).
        expect(diverged.length).toBeGreaterThan(0);
      } else {
        // Everything else must be byte-for-byte identical to svelte/compiler.
        expect(diverged).toEqual([]);
      }
    });
  }
});
