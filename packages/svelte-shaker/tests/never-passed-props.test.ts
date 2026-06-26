import { describe, expect, it } from 'vitest';
import { buildAnalyzeInput, findNeverPassedProps } from '../src/index';
import type { ReadFile, Resolve } from '../src/index';

const resolve: Resolve = (source, importer) =>
  source.startsWith('.') ? new URL(source, `file://${importer}`).pathname : null;

async function unpassed(files: Record<string, string>, entries = Object.keys(files)) {
  const readFile: ReadFile = (id) => files[id]!;
  const input = await buildAnalyzeInput(entries, resolve, readFile);
  const map = await Promise.resolve(findNeverPassedProps(input));
  const out: Record<string, string[]> = {};
  for (const [id, props] of map) out[id] = props.map((p) => p.name).sort();
  return out;
}

describe('findNeverPassedProps', () => {
  it('flags a declared prop no call site passes (and not one that is passed)', async () => {
    const res = await unpassed({
      '/App.svelte': "<script>import C from './C.svelte';</script>\n<C a={1} />",
      '/C.svelte': '<script>let { a, b } = $props();</script>\n{a}{b}',
    });
    expect(res['/C.svelte']).toEqual(['b']); // `a` is passed, `b` never is
  });

  it('counts bind:, spread, and body/children as "passed"', async () => {
    const res = await unpassed({
      '/App.svelte': [
        "<script>import C from './C.svelte';</script>",
        '<C bind:bound {...rest}>hi</C>',
      ].join('\n'),
      '/C.svelte':
        '<script>let { bound = $bindable(), children, anything } = $props();</script>\n{@render children?.()}{bound}{anything}',
    });
    // `bound` via bind:, `children` via body, `anything` possibly via spread → none flagged.
    expect(res['/C.svelte']).toBeUndefined();
  });

  it('skips a component with ZERO call sites (entry / route / framework-injected)', async () => {
    const res = await unpassed({
      // App does not render Page; Page is an "entry" whose props come from outside.
      '/App.svelte': '<p>home</p>',
      '/Page.svelte': '<script>let { data } = $props();</script>\n{data}',
    });
    expect(res['/Page.svelte']).toBeUndefined();
  });

  it('skips a bailed component (escaped as a value)', async () => {
    const res = await unpassed({
      '/App.svelte': [
        "<script>import C from './C.svelte';</script>",
        '<C a={1} />',
        '<svelte:component this={C} />',
      ].join('\n'),
      '/C.svelte': '<script>let { a, b } = $props();</script>\n{a}{b}',
    });
    expect(res['/C.svelte']).toBeUndefined(); // escaped → prop profile unknowable
  });
});
