import { afterAll, describe, expect, it } from 'vitest';
import { svelteShaker } from '../src/index';
import { analyze } from '../src/analyze';
import { assertCompiles, cleanTmp, renderGraphHtml } from './diff';

afterAll(() => cleanTmp());

// ----------------------------------------------------------------------
// Deep pass-through chains (docs §13.1): the fixpoint propagates a folded
// constant one hop per round, so a chain longer than the old fixed cap of 10
// rounds left its deepest components under-narrowed (sound but unoptimized).
// The bound now scales with the component count, so a fold at the top of a
// realistic-depth chain reaches the leaf.  Each probe still asserts the whole
// program server-renders identical HTML (the soundness oracle).
// ----------------------------------------------------------------------

/** Minimal in-memory module graph for the engine (POSIX-style absolute ids). */
function memGraph(files: Record<string, string>): {
  resolve: (source: string, importer: string) => string | null;
  readFile: (id: string) => string;
} {
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
  return { resolve, readFile };
}

/** Render the whole `/App.svelte` graph (flat `/X.svelte` ids) to HTML. */
async function graphHtml(files: Record<string, string>): Promise<string> {
  const deps: Record<string, string> = {};
  for (const [id, src] of Object.entries(files)) {
    if (id === '/App.svelte') continue;
    deps[`.${id}`] = src; // `/S1.svelte` -> `./S1.svelte`
  }
  return renderGraphHtml({ specifier: './App.svelte', source: files['/App.svelte']! }, deps, {});
}

/**
 * Shake `files` from `/App.svelte`, assert the whole graph renders identical
 * HTML before/after (the soundness oracle) and every shaken file compiles, and
 * return the shaken sources merged over the originals.
 */
async function shakeSound(files: Record<string, string>): Promise<Record<string, string>> {
  const { resolve, readFile } = memGraph(files);
  const out = await svelteShaker('/App.svelte', resolve, readFile);
  const merged = { ...files, ...out };
  for (const [id, src] of Object.entries(out))
    assertCompiles(src, id.slice(id.lastIndexOf('/') + 1));
  const before = await graphHtml(files);
  const after = await graphHtml(merged);
  expect(after).toBe(before);
  return merged;
}

async function plansFor(files: Record<string, string>) {
  const { resolve, readFile } = memGraph(files);
  return (await analyze('/App.svelte', resolve, readFile)).plans;
}

/**
 * A pass-through chain `App -> S1 -> S2 -> … -> Sn`: `App` passes the literal
 * `"go"` to `S1`, every `Sk` forwards its `v` to `S(k+1)`, and the leaf `Sn`
 * gates a `{#if}` on it.  Folding the literal requires one round per hop, so the
 * leaf folds only when the bound admits `n` rounds — `App` plus `n` chain files
 * is `n + 1` components, which the scaled bound covers.
 */
function deepChain(n: number): Record<string, string> {
  const files: Record<string, string> = {
    '/App.svelte': `<script>\n  import S1 from './S1.svelte';\n</script>\n<S1 v="go" />\n`,
  };
  for (let k = 1; k < n; k++) {
    files[`/S${k}.svelte`] =
      `<script>\n  import S${k + 1} from './S${k + 1}.svelte';\n  let { v } = $props();\n</script>\n` +
      `<S${k + 1} v={v} />\n`;
  }
  files[`/S${n}.svelte`] =
    `<script>\n  let { v = 'stop' } = $props();\n</script>\n` +
    `{#if v === 'go'}<b>GO</b>{:else}<i>stop</i>{/if}\n`;
  return files;
}

describe('deep pass-through chains reach the leaf', () => {
  it('14-stage chain folds the forwarded constant all the way to the deepest component', async () => {
    // 14 chain files (+ App = 15 components) needs 14 propagation rounds — past the
    // old fixed cap of 10, so on `main` S12..S14 stay dynamic. The scaled bound
    // (>= components + 1) admits enough rounds for the fold to reach the leaf.
    const files = deepChain(14);
    const plans = await plansFor(files);

    // Every hop folded, right down to the leaf — not just the first 10.
    expect(plans.get('/S12.svelte')!.constFold.get('v')).toBe('go');
    expect(plans.get('/S13.svelte')!.constFold.get('v')).toBe('go');
    expect(plans.get('/S14.svelte')!.constFold.get('v')).toBe('go');

    const out = await shakeSound(files);
    const leaf = out['/S14.svelte']!;
    // The dead `{:else}` arm is gone and the folded prop dropped from the signature.
    expect(leaf).toContain('<b>GO</b>');
    expect(leaf).not.toContain('stop</i>');
    expect(leaf).not.toMatch(/let \{ v/);
  });
});
