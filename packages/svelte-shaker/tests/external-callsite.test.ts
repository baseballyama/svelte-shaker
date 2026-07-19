import { afterAll, describe, expect, it } from 'vitest';
import { buildAnalyzeInput, findNeverPassedProps, svelteShaker } from '../src/index';
import type { ReadFile, Resolve } from '../src/index';
import { renderHtml } from './diff';

// A component consumed BOTH from a `.svelte` template (which omits `p`) AND from a
// `.ts` module (`mount(Widget, { props: { p: true } })`).  The shaker's crawl only
// parses `.svelte`, so the `.ts` call site is invisible: without the external-escape
// mechanism it (unsoundly) concludes `p` is never passed and folds it to its default.
const WIDGET = [
  '<script lang="ts">',
  '  let { p = false }: { p?: boolean } = $props();',
  '</script>',
  '',
  '{#if p}<span>P BRANCH</span>{/if}',
  '<span>base</span>',
].join('\n');

const APP = [
  '<script>',
  "  import Widget from './Widget.svelte';",
  '</script>',
  '',
  '<Widget />',
].join('\n');

const MAIN_TS = [
  "import { mount } from 'svelte';",
  "import Widget from './Widget.svelte';",
  'mount(Widget, { target: document.body, props: { p: true } });',
].join('\n');

const FILES: Record<string, string> = {
  '/App.svelte': APP,
  '/Widget.svelte': WIDGET,
  '/main.ts': MAIN_TS,
};

const resolve: Resolve = (source, importer) =>
  source.startsWith('.') ? new URL(source, `file://${importer}`).pathname : null;
const readFile: ReadFile = (id) => FILES[id]!;

afterAll(() => {
  /* no temp dirs of our own */
});

describe('external (.ts/.js) call sites — soundness', () => {
  // Documents the hole: crawling only `.svelte`, the shaker over-folds `p`.  This
  // is the exact unsoundness Phase 1b closes by scanning `main.ts`.
  it('marking the component as externally escaped keeps `p` (matches the `.ts` consumer)', async () => {
    // The 5th argument is the external-escape set (Phase 1b): the ids of components
    // with consumers the `.svelte` crawl cannot see (`main.ts` here).  Without it
    // the shaker folds `p` to its default and drops the branch — unsound.
    const shaken = await svelteShaker(
      ['/App.svelte', '/Widget.svelte'],
      resolve,
      readFile,
      undefined,
      ['/Widget.svelte'],
    );
    const widget = shaken['/Widget.svelte']!;

    // The sound result: `p` is preserved, so `mount(Widget, { props: { p: true } })`
    // still renders the branch.  The differential SSR oracle proves observable
    // equivalence with the original for the value the `.ts` call site passes.
    const before = await renderHtml(WIDGET, { p: true }, 'Widget.svelte');
    const after = await renderHtml(widget, { p: true }, 'Widget.svelte');
    expect(after).toBe(before);
    expect(before).toContain('P BRANCH');
  });

  it('findNeverPassedProps does not over-report a prop passed only from a `.ts` module', async () => {
    const input = await buildAnalyzeInput(['/App.svelte', '/Widget.svelte'], resolve, readFile);
    const withExternal = { ...input, escaped: ['/Widget.svelte'] };
    const map = findNeverPassedProps(withExternal);
    // `p` IS passed — by `main.ts` — so it must not be flagged as never-passed.
    expect(map.get('/Widget.svelte')).toBeUndefined();
  });
});
