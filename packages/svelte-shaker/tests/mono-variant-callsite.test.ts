import { afterAll, describe, expect, it } from 'vitest';
import { svelteShakerWithMono } from '../src/index';
import { assertCompiles, cleanTmp, renderGraphHtml } from './diff';
import { memGraph } from './mem-graph';

afterAll(() => cleanTmp());

// ----------------------------------------------------------------------
// A monomorphization variant is rendered by the body pass alone, so the call-site
// cleanup the base transform runs afterwards (removing the attribute of a prop the
// CHILD dropped — folded, or declared but never read) never reaches the variant's
// own `<Child .../>` sites.  When that child keeps a `...rest`, the still-passed
// attribute lands in it and renders (`<p v="a">`).  An owner whose call sites the
// base would edit is therefore never specialized.
//
// The size measure prices every variant at 0 so the net-win gate always accepts:
// these tests exercise eligibility, not the gate.
// ----------------------------------------------------------------------

const ON = { enabled: true, maxVariants: 8, minSavings: 0 } as const;
const variantsFree = (id: string, source: string): number =>
  id.includes('::v') ? 0 : source.length;
/** `/Mid.svelte::v0` -> `./Mid__v0.svelte`, a graph-local module the owner imports. */
const variantSpecifier = (id: string): string =>
  `./${id.slice(1).replace('.svelte::v', '__v')}.svelte`;

const HEAVY =
  '<div class="heavy">' +
  Array.from({ length: 40 }, (_, i) => `<span>heavy ${i}</span>`).join('') +
  '</div>';

/** Shake with monomorphization on, assert every emitted module compiles and the
 * whole graph (variants included) renders the same HTML; return the variant count. */
async function shakeSound(files: Record<string, string>): Promise<number> {
  const { resolve, readFile } = memGraph(files);
  const res = await svelteShakerWithMono(
    '/App.svelte',
    resolve,
    readFile,
    ON,
    variantSpecifier,
    undefined,
    undefined,
    variantsFree,
  );
  const shaken: Record<string, string> = { ...files, ...res.files };
  for (const v of res.mono.variants.values()) shaken[variantSpecifier(v.id).slice(1)] = v.code;
  for (const [id, src] of Object.entries(shaken)) assertCompiles(src, id.slice(1));
  const html = async (graph: Record<string, string>): Promise<string> => {
    const deps: Record<string, string> = {};
    for (const [id, src] of Object.entries(graph)) if (id !== '/App.svelte') deps[`.${id}`] = src;
    return renderGraphHtml({ specifier: './App.svelte', source: graph['/App.svelte']! }, deps, {});
  };
  expect(await html(shaken)).toBe(await html(files));
  return res.mono.variants.size;
}

const MID_SCRIPT = `import Heavy from './Heavy.svelte'; import Grand from './Grand.svelte';`;
const MID_HEAVY = `{#if a === 1 && b === 1}<Heavy />{/if}`;
const base = {
  '/Heavy.svelte': `<script>let { n = 0 } = $props();</script>${HEAVY}`,
};

describe('mono variants never leak an attribute the child dropped', () => {
  it('a forwarded folded prop', async () => {
    await shakeSound({
      ...base,
      '/App.svelte': `<script>import Mid from './Mid.svelte';</script><Mid a={0} b={1} x="a" /><Mid a={1} b={0} x="a" />`,
      '/Mid.svelte': `<script>${MID_SCRIPT} let { a, b, x } = $props();</script>${MID_HEAVY}<Grand v={x} /><p>base</p>`,
      '/Grand.svelte': `<script>let { v, ...rest } = $props();</script><p {...rest}>{v}</p>`,
    });
  });

  it('a forwarded demoted one-value narrow prop', async () => {
    await shakeSound({
      ...base,
      '/App.svelte': `<script>import Mid from './Mid.svelte'; let { f = false } = $props();</script><Mid a={0} b={1} s="a" flag={f} /><Mid a={1} b={0} s="a" flag={f} />`,
      '/Mid.svelte': `<script>${MID_SCRIPT} let { a, b, s, flag } = $props();</script>${MID_HEAVY}{#if flag}<div use:s>x</div>{/if}<Grand v={s} /><p>base</p>`,
      '/Grand.svelte': `<script>let { v, ...rest } = $props();</script><p {...rest}>{v}</p>`,
    });
  });

  it('a declared-but-unread prop', async () => {
    await shakeSound({
      ...base,
      '/App.svelte': `<script>import Mid from './Mid.svelte';</script><Mid a={0} b={1} /><Mid a={1} b={0} />`,
      '/Mid.svelte': `<script>${MID_SCRIPT} let { a, b } = $props();</script>${MID_HEAVY}<Grand u="x" /><p>base</p>`,
      '/Grand.svelte': `<script>let { u, ...rest } = $props();</script><p {...rest}>grand</p>`,
    });
  });

  it('still specializes an owner whose call sites the base leaves alone', async () => {
    const variants = await shakeSound({
      ...base,
      '/App.svelte': `<script>import Mid from './Mid.svelte';</script><Mid a={0} b={1} /><Mid a={1} b={0} />`,
      '/Mid.svelte': `<script>${MID_SCRIPT} let { a, b } = $props();</script>${MID_HEAVY}<Grand v={a} /><p>base</p>`,
      '/Grand.svelte': `<script>let { v, ...rest } = $props();</script><p {...rest}>{v}</p>`,
    });
    expect(variants).toBeGreaterThan(0);
  });
});
