import { afterAll, describe, expect, it } from 'vitest';
import { DevShaker, svelteShaker, type DevMode } from '../src/index';
import { assertCompiles, cleanTmp, renderHtml } from './diff';

afterAll(() => cleanTmp());

// ----------------------------------------------------------------------
// dev incremental shake — the differential oracle (docs/RUST-MIGRATION.md §3 M2,
// §4).  The DevShaker keeps long-lived state and re-shakes on each file change;
// its correctness is defended by pinning, after EVERY change, that its output is
// byte-for-byte identical to a from-scratch `svelteShaker` of the current file
// set — for BOTH `'coarse'` and `'incremental'` modes.  Because the batch engine
// is independently SSR-tested (basic/shadow/probes2/css), "incremental === full"
// transitively inherits that soundness; we add a direct SSR-equivalence spot
// check too.  This is the M2 gate: the incremental engine must never drift from
// the trusted whole-program result, or dev would silently diverge from prod.
//
// The sequence exercises every kind of change the inverted cascade dependency
// cares about: editing a call site (changes a CHILD's residual), adding a file
// (a new call site can un-shake a child), removing a file (can re-shake it),
// editing a leaf's own markup, and dropping a usage entirely.
// ----------------------------------------------------------------------

/** Mutable in-memory module graph (POSIX-style absolute ids). */
function mutableGraph(initial: Record<string, string>): {
  files: Record<string, string>;
  resolve: (source: string, importer: string) => string | null;
  readFile: (id: string) => string;
  svelteIds: () => string[];
} {
  const files = { ...initial };
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
  const readFile = (id: string): string => {
    const code = files[id];
    if (code === undefined) throw new Error(`no such file: ${id}`);
    return code;
  };
  const svelteIds = (): string[] => Object.keys(files).filter((f) => f.endsWith('.svelte'));
  return { files, resolve, readFile, svelteIds };
}

const APP_ONE_SUB = `<script>
  import Sub from './Sub.svelte';
</script>
<Sub />`;

const APP_ICON = `<script>
  import Sub from './Sub.svelte';
</script>
<Sub hasIcon={true} />`;

const APP_NO_SUB = `<script>
  import Sub from './Sub.svelte';
</script>
<p>hi</p>`;

const SUB = `<script>
  let { hasIcon = false } = $props();
</script>
{#if hasIcon}<p>Icon</p>{/if}
<p>base</p>`;

const SUB_EDITED = SUB.replace('<p>base</p>', '<p>BASE</p>');

const OTHER = `<script>
  import Sub from './Sub.svelte';
</script>
<Sub hasIcon={false} />`;

describe('dev incremental shake differential oracle', () => {
  for (const mode of ['coarse', 'incremental'] as DevMode[]) {
    it(`[${mode}] stays byte-identical to a full shake across an edit sequence`, async () => {
      const g = mutableGraph({ '/App.svelte': APP_ONE_SUB, '/Sub.svelte': SUB });
      const engine = new DevShaker(g.svelteIds(), g.resolve, g.readFile, mode);

      /** Re-shake the whole program from scratch — the trusted reference. */
      const full = (): Promise<Record<string, string>> =>
        svelteShaker(g.svelteIds(), g.resolve, g.readFile);

      await engine.init();
      expect(engine.snapshot()).toEqual(await full());

      // init: `hasIcon` is never passed -> folded to its `false` default and
      // dropped, so the `{#if}` and its `Icon` are gone.
      expect(engine.get('/Sub.svelte')).not.toContain('hasIcon');
      expect(engine.get('/Sub.svelte')).not.toContain('Icon');

      // Step 1 — edit a call site: App now passes `hasIcon={true}`.  `hasIcon`
      // collapses to the constant `true` (single site), so Sub keeps `Icon`.  The
      // sharpest form of the HMR divergence: the EDITED file's own output is
      // UNCHANGED (the added `hasIcon={true}` attribute is shaken right back off,
      // so App's residual is still `<Sub />`), yet the un-edited CHILD's residual
      // changed.  So the widened set is exactly `{Sub}`, not `{App}`.
      g.files['/App.svelte'] = APP_ICON;
      let res = await engine.update({ changed: ['/App.svelte'] });
      expect(engine.snapshot()).toEqual(await full());
      expect(Object.keys(res.changed)).toEqual(['/Sub.svelte']);
      expect(res.removed).toEqual([]);
      expect(engine.get('/Sub.svelte')).toContain('Icon');

      // Step 2 — add a file with a DIFFERENT value: `hasIcon ∈ {true,false}` is
      // now a 2-element set, so it can no longer fold; Sub reverts to its full
      // form and App's attribute comes back.
      g.files['/Other.svelte'] = OTHER;
      res = await engine.update({ added: ['/Other.svelte'] });
      expect(engine.snapshot()).toEqual(await full());
      expect(engine.get('/Sub.svelte')).toContain('hasIcon');

      // Step 3 — remove that file: back to a single `true` site -> folds again.
      delete g.files['/Other.svelte'];
      res = await engine.update({ removed: ['/Other.svelte'] });
      expect(engine.snapshot()).toEqual(await full());
      expect(res.removed).toEqual(['/Other.svelte']);
      expect(engine.get('/Sub.svelte')).toContain('Icon');

      // Step 4 — edit a leaf's OWN markup only: just that file's output changes,
      // App's does not (precision: we must not over-report the changed set).
      g.files['/Sub.svelte'] = SUB_EDITED;
      res = await engine.update({ changed: ['/Sub.svelte'] });
      expect(engine.snapshot()).toEqual(await full());
      expect(Object.keys(res.changed)).toEqual(['/Sub.svelte']);

      // Step 5 — drop the usage entirely: Sub has no call site, so it is left
      // untouched (its `hasIcon` is no longer provably constant).
      g.files['/App.svelte'] = APP_NO_SUB;
      res = await engine.update({ changed: ['/App.svelte'] });
      expect(engine.snapshot()).toEqual(await full());
      expect(engine.get('/Sub.svelte')).toContain('hasIcon');

      // Every shaken file the sequence produced must still compile.
      for (const [id, code] of Object.entries(engine.snapshot())) assertCompiles(code, id);
    });
  }

  it('the folded child is SSR-equivalent to the original for the value that occurs', async () => {
    const g = mutableGraph({ '/App.svelte': APP_ONE_SUB, '/Sub.svelte': SUB });
    const engine = new DevShaker(g.svelteIds(), g.resolve, g.readFile, 'incremental');
    await engine.init();

    // App never passes `hasIcon`, so it folds to its `false` default.  The shaken
    // Sub (prop dropped) must render the SAME HTML as the original Sub does with
    // `hasIcon=false` — the only value that ever reaches it.
    const shaken = await renderHtml(engine.get('/Sub.svelte')!, {}, '/Sub.svelte');
    const original = await renderHtml(SUB, { hasIcon: false }, '/Sub.svelte');
    expect(shaken).toBe(original);
  });
});
