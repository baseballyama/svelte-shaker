import { readdirSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { describe, expect, it } from 'vitest';
import { svelteShaker } from '../src/index';
import { parseSvelte } from '../src/parse';
import { tryLoadRsvelteParser } from '../src/rsvelte-parse';
import { fsReadFile, fsResolve } from '../src/scan';
import { assertCompiles, cleanTmp, renderHtml } from './diff';
import { afterAll } from 'vitest';

afterAll(() => cleanTmp());

// ----------------------------------------------------------------------
// The `parser` seam (docs/RUST-MIGRATION.md §6): `svelteShaker`'s optional 4th
// argument swaps the parser that feeds the engine. The default (svelte/compiler)
// path must be untouched; an alternate parser (rsvelte's native parser) must drive
// the SAME engine to sound output.
// ----------------------------------------------------------------------

const FIXTURES = resolvePath(__dirname, 'fixtures');
const fixtureNames = readdirSync(FIXTURES, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

describe('parser seam: explicit svelte/compiler is transparent', () => {
  for (const name of fixtureNames) {
    it(`${name}: passing parseSvelte == the default path (byte-identical)`, async () => {
      const entry = join(FIXTURES, name, 'input', 'App.svelte');
      const viaDefault = await svelteShaker(entry, fsResolve, fsReadFile);
      const viaExplicit = await svelteShaker(entry, fsResolve, fsReadFile, (code, id) =>
        parseSvelte(code, id),
      );
      expect(viaExplicit).toEqual(viaDefault);
    });
  }

  it('parses each file ONCE through the shared cache (no double-parse with a custom parser)', async () => {
    // A custom parser that counts invocations proves the crawl + analysis share one
    // parse per file (the seam seeds a cache during the crawl that the analysis
    // reuses) — the basis of the rsvelte speed win.
    const counts = new Map<string, number>();
    const counting = (code: string, id: string) => {
      counts.set(id, (counts.get(id) ?? 0) + 1);
      return parseSvelte(code, id);
    };
    const entry = join(FIXTURES, 'cascade', 'input', 'App.svelte');
    await svelteShaker(entry, fsResolve, fsReadFile, counting);
    for (const [id, n] of counts) expect(n, id).toBe(1);
  });
});

describe('parser seam: rsvelte native parser drives the engine', () => {
  const rsvelte = tryLoadRsvelteParser();

  it('tryLoadRsvelteParser returns a working parser (native package installed)', () => {
    expect(rsvelte).toBeTypeOf('function');
    const ast = rsvelte!('<script>let x = 1;</script>{x}', '/X.svelte');
    // svelte/compiler modern shape: a Root with an instance script + fragment.
    expect(ast).toHaveProperty('fragment');
  });

  it.skipIf(!rsvelte)('produces sound (compiling) output across every fixture', async () => {
    for (const name of fixtureNames) {
      const entry = join(FIXTURES, name, 'input', 'App.svelte');
      const out = await svelteShaker(entry, fsResolve, fsReadFile, rsvelte!);
      for (const [id, code] of Object.entries(out)) assertCompiles(code, id);
    }
  });

  it.skipIf(!rsvelte)('folds a never-passed prop identically to svelte/compiler', async () => {
    const files: Record<string, string> = {
      '/App.svelte': `<script>\n  import Sub from './Sub.svelte';\n</script>\n<Sub />`,
      '/Sub.svelte': `<script>\n  let { hasIcon = false } = $props();\n</script>\n{#if hasIcon}<p>Icon</p>{/if}\n<p>base</p>`,
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
    const viaSvelte = await svelteShaker('/App.svelte', resolve, readFile);
    const viaRsvelte = await svelteShaker('/App.svelte', resolve, readFile, rsvelte!);
    expect(viaRsvelte).toEqual(viaSvelte);
    expect(viaRsvelte['/Sub.svelte']).not.toContain('Icon');
    // soundness: the rsvelte-driven residual renders identically.
    expect(await renderHtml(viaRsvelte['/Sub.svelte']!, {}, '/Sub.svelte')).toBe(
      await renderHtml(files['/Sub.svelte']!, {}, '/Sub.svelte'),
    );
  });
});
