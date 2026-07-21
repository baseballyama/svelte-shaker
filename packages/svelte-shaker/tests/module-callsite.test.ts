import { afterAll, describe, expect, it } from 'vitest';
import { buildAnalyzeInput, findNeverPassedProps, svelteShaker } from '../src/index';
import type { ReadFile, Resolve } from '../src/index';
import { renderHtml } from './diff';

// A component consumed BOTH from a `.svelte` template (which omits `p`) AND from a
// `.ts` module (`mount(Widget, { props: { p: true } })`).  The shaker's crawl only
// parses `.svelte`, so the `.ts` call site is invisible: without the module-escape
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

describe('non-.svelte module (.ts/.js) call sites — soundness', () => {
  // Documents the hole: crawling only `.svelte`, the shaker over-folds `p`.  This
  // is the exact unsoundness Phase 1b closes by scanning `main.ts`.
  it('marking the component as module-escaped keeps `p` (matches the `.ts` consumer)', async () => {
    // The 5th argument is the module-escape set (Phase 1b): the ids of components
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
    const withModuleEscape = { ...input, escaped: ['/Widget.svelte'] };
    const map = findNeverPassedProps(withModuleEscape);
    // `p` IS passed — by `main.ts` — so it must not be flagged as never-passed.
    expect(map.get('/Widget.svelte')).toBeUndefined();
  });

  // Guards the interaction with interprocedural pass-through (docs §13.1): a folded
  // constant must not propagate THROUGH an escaped owner to its child.  `Mid`
  // forwards its `v` to `<Leaf label={v}>`; App renders `<Mid/>` without `v`, so
  // absent any escape `v` folds to 'base' and propagates, folding `Leaf.label`.  If
  // a `.ts` module mounts `Mid` with a different `v`, escaping `Mid` must un-fold
  // both `v` AND `Leaf.label` — the escape has to reach through the pass-through.
  it('an escaped pass-through owner does not propagate a folded constant to its child', async () => {
    const files: Record<string, string> = {
      '/App.svelte': "<script>import Mid from './Mid.svelte';</script>\n<Mid />",
      '/Mid.svelte':
        "<script>import Leaf from './Leaf.svelte';\n  let { v = 'base' } = $props();</script>\n<Leaf label={v} />",
      '/Leaf.svelte':
        "<script>let { label = 'x' } = $props();</script>\n{#if label === 'base'}<b>BASE</b>{/if}\n<span>{label}</span>",
    };
    const read: ReadFile = (id) => files[id]!;
    const entries = ['/App.svelte', '/Mid.svelte', '/Leaf.svelte'];

    // Baseline: with nothing escaped, the pass-through folds `Leaf.label` to 'base'
    // and proves the `label === 'base'` branch, so the comparison disappears.
    const plain = await svelteShaker(entries, resolve, read);
    expect(plain['/Leaf.svelte']).not.toContain('label ===');

    // Escaping `Mid` bails it, so `v` is neither folded nor propagated: `Leaf.label`
    // stays dynamic and its branch survives.  The escape reaches past the seam.
    const escaped = await svelteShaker(entries, resolve, read, undefined, ['/Mid.svelte']);
    expect(escaped['/Leaf.svelte']).toContain('label ===');
  });

  // Guards the interaction with unread-input elimination (docs §PR4): #106 drops a
  // call-site input the child never reads AND the unread prop from the child's
  // signature.  An escaped child must be left COMPLETELY untouched — neither its
  // signature nor the inputs feeding it may be stripped, since its consumers are
  // not all observable.  `Child` reads `p` but never `q`.
  it('an escaped child keeps an unread prop and its call-site input (untouched)', async () => {
    const child = '<script>let { p = false, q } = $props();</script>\n{#if p}<b>P</b>{/if}\n';
    const app =
      "<script>import Child from './Child.svelte';\n  let x = Math.random();</script>\n<Child p={x > 0.5} q={1} />\n";
    const files: Record<string, string> = { '/App.svelte': app, '/Child.svelte': child };
    const read: ReadFile = (id) => files[id]!;
    const entries = ['/App.svelte', '/Child.svelte'];

    // Baseline: `q` is unread, so #106 drops it from `$props()` and from the call site.
    const plain = await svelteShaker(entries, resolve, read);
    expect(plain['/Child.svelte']).not.toContain('q');
    expect(plain['/App.svelte']).not.toContain('q={1}');

    // Escaped: the child is bailed, so it and the inputs feeding it are untouched.
    const escaped = await svelteShaker(entries, resolve, read, undefined, ['/Child.svelte']);
    expect(escaped['/Child.svelte']).toBe(child);
    expect(escaped['/App.svelte']).toContain('q={1}');
  });
});
