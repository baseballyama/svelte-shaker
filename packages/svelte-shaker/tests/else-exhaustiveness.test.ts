import { afterAll, describe, expect, it } from 'vitest';
import { svelteShaker } from '../src/index';
import { analyze } from '../src/analyze';
import { assertCompiles, cleanTmp, renderGraphHtml } from './diff';

afterAll(() => cleanTmp());

// ----------------------------------------------------------------------
// {:else} exhaustiveness removal (docs §3, PR11).
//
// When an if/else-if chain ends in `{:else}` and every test is driven by ONE
// narrowed prop `v` (value set known), the else arm is dead iff every value the
// set can take makes some earlier test fire.  This is the sound bridge from
// "variant ∈ {primary, secondary}" to "the trailing `{:else}` can never render".
//
// Each probe builds an in-memory App -> … -> leaf graph, runs the real engine,
// and asserts BOTH the removal where expected AND byte-equal SSR HTML (oracle).
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
    deps[`.${id}`] = src; // `/Mid.svelte` -> `./Mid.svelte`
  }
  return renderGraphHtml({ specifier: './App.svelte', source: files['/App.svelte']! }, deps, {});
}

/**
 * Shake `files` from `/App.svelte`, assert the whole graph renders identical HTML
 * before/after (the soundness oracle) and every shaken file compiles, and return
 * the shaken sources merged over the originals.
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

describe('{:else} exhaustiveness removal', () => {
  it('1: a set covered by the arms drops the trailing {:else} and its child call site', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n</script>\n` +
        `<Child variant="primary" />\n<Child variant="secondary" />\n`,
      '/Child.svelte':
        `<script>\n  import Heavy from './Heavy.svelte';\n  let { variant = 'other' } = $props();\n</script>\n` +
        `{#if variant === 'primary'}<b>P</b>{:else if variant === 'secondary'}<em>S</em>{:else}<Heavy />{/if}\n`,
      '/Heavy.svelte': `<div class="heavy">HEAVY</div>\n`,
    };
    const plans = await plansFor(files);
    expect(plans.get('/Child.svelte')!.narrow.get('variant')).toEqual(['primary', 'secondary']);

    const out = await shakeSound(files);
    const child = out['/Child.svelte']!;
    expect(child).not.toContain('<Heavy'); // the else call site is gone
    expect(child).not.toContain('{:else}'); // no stray else marker left
    expect(child).toContain('<b>P</b>'); // reachable arms stay
    expect(child).toContain('<em>S</em>');
  });

  it('2: a set forwarded through a pass-through owner still drops the {:else} in the child', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Mid from './Mid.svelte';\n</script>\n` +
        `<Mid variant="primary" />\n<Mid variant="secondary" />\n`,
      '/Mid.svelte':
        `<script>\n  import Child from './Child.svelte';\n  let { variant } = $props();\n</script>\n` +
        `<Child variant={variant} />\n`,
      '/Child.svelte':
        `<script>\n  import Heavy from './Heavy.svelte';\n  let { variant = 'other' } = $props();\n</script>\n` +
        `{#if variant === 'primary'}<b>P</b>{:else if variant === 'secondary'}<em>S</em>{:else}<Heavy />{/if}\n`,
      '/Heavy.svelte': `<div>HEAVY</div>\n`,
    };
    const plans = await plansFor(files);
    expect(plans.get('/Child.svelte')!.narrow.get('variant')).toEqual(['primary', 'secondary']);

    const out = await shakeSound(files);
    expect(out['/Child.svelte']!).not.toContain('<Heavy');
    expect(out['/Child.svelte']!).toContain('<em>S</em>');
  });

  it('3: a value whose test cannot be settled keeps the {:else}', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n</script>\n` +
        `<Child variant="alpha" />\n<Child variant="beta" />\n`,
      '/Child.svelte':
        `<script>\n  import Heavy from './Heavy.svelte';\n  let { variant = 'other' } = $props();\n</script>\n` +
        `{#if variant.startsWith('a')}<b>A</b>{:else}<Heavy />{/if}\n`,
      '/Heavy.svelte': `<div>HEAVY</div>\n`,
    };
    const plans = await plansFor(files);
    expect(plans.get('/Child.svelte')!.narrow.get('variant')).toEqual(['alpha', 'beta']);

    const out = await shakeSound(files);
    expect(out['/Child.svelte']!).toContain('<Heavy'); // test never proven -> else stays
  });

  it('4: two set-vars in the tests skip the check (else stays)', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n</script>\n` +
        `<Child a="x" b="y" />\n<Child a="p" b="q" />\n`,
      '/Child.svelte':
        `<script>\n  import Heavy from './Heavy.svelte';\n  let { a = '', b = '' } = $props();\n</script>\n` +
        `{#if a === 'x'}<b>X</b>{:else if b === 'y'}<em>Y</em>{:else}<Heavy />{/if}\n`,
      '/Heavy.svelte': `<div>HEAVY</div>\n`,
    };
    const plans = await plansFor(files);
    // Both props narrow to a 2-value set, so the tests mention two set-vars.
    expect(plans.get('/Child.svelte')!.narrow.get('a')).toEqual(['x', 'p']);
    expect(plans.get('/Child.svelte')!.narrow.get('b')).toEqual(['y', 'q']);

    const out = await shakeSound(files);
    expect(out['/Child.svelte']!).toContain('<Heavy'); // cartesian product out of scope
  });

  it('5: a chain with no {:else} is unchanged apart from an out-of-set dead arm (regression)', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n</script>\n` +
        `<Child v="a" />\n<Child v="b" />\n`,
      '/Child.svelte':
        `<script>\n  let { v = 'z' } = $props();\n</script>\n` +
        `{#if v === 'a'}<b>A</b>{:else if v === 'z'}<i>Z</i>{:else if v === 'b'}<em>B</em>{/if}\n`,
    };
    const plans = await plansFor(files);
    expect(plans.get('/Child.svelte')!.narrow.get('v')).toEqual(['a', 'b']);

    const out = await shakeSound(files);
    const child = out['/Child.svelte']!;
    expect(child).not.toContain('<i>Z</i>'); // out-of-set arm removed
    expect(child).toContain('<b>A</b>');
    expect(child).toContain('<em>B</em>');
  });

  it('6: removing the {:else} cascades so the child call site inside it drops from a leaf profile', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n</script>\n` +
        `<Child variant="primary" />\n<Child variant="secondary" />\n`,
      '/Child.svelte':
        `<script>\n  import Leaf from './Leaf.svelte';\n  let { variant = 'other' } = $props();\n</script>\n` +
        `{#if variant === 'primary'}<Leaf kind="live" />` +
        `{:else if variant === 'secondary'}<Leaf kind="live" />` +
        `{:else}<Leaf kind="dead" />{/if}\n`,
      '/Leaf.svelte':
        `<script>\n  let { kind = 'x' } = $props();\n</script>\n` +
        `{#if kind === 'live'}<b>L</b>{:else}<i>{kind}</i>{/if}\n`,
    };
    const plans = await plansFor(files);
    // The `{:else}` (kind="dead") call site sits in a dead span, so Leaf only ever
    // sees kind="live" -> it collapses to a single constant, not a 2-value set.
    expect(plans.get('/Leaf.svelte')!.constFold.get('kind')).toBe('live');
    expect(plans.get('/Leaf.svelte')!.narrow.has('kind')).toBe(false);

    const out = await shakeSound(files);
    expect(out['/Child.svelte']!).not.toContain('kind="dead"'); // else call site gone
    expect(out['/Leaf.svelte']!).not.toContain('<i>'); // Leaf's dead arm folded away
  });

  it('7: a prop that never narrows (owner writes it) keeps the {:else}', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Mid from './Mid.svelte';\n</script>\n` +
        `<Mid variant="primary" />\n<Mid variant="secondary" />\n`,
      '/Mid.svelte':
        `<script>\n  import Child from './Child.svelte';\n  let { variant } = $props();\n  variant = 'danger';\n</script>\n` +
        `<Child v={variant} />\n`,
      '/Child.svelte':
        `<script>\n  import Heavy from './Heavy.svelte';\n  let { v = 'other' } = $props();\n</script>\n` +
        `{#if v === 'primary'}<b>P</b>{:else if v === 'secondary'}<em>S</em>{:else}<Heavy />{/if}\n`,
      '/Heavy.svelte': `<div>HEAVY</div>\n`,
    };
    const plans = await plansFor(files);
    expect(plans.get('/Child.svelte')!.narrow.has('v')).toBe(false);

    const out = await shakeSound(files);
    expect(out['/Child.svelte']!).toContain('<Heavy'); // no narrowing -> no exhaustiveness
  });

  it('9: an empty last-arm consequent bails (no span-inversion crash, else kept)', async () => {
    // `{:else if variant === 'secondary'}{:else}…` — the last arm before the else
    // renders nothing, so it has no consequent-end offset to anchor the removal on.
    // We must bail (keep the else) rather than fall back to the block end, which is
    // the chain's `{/if}` past the else content and would invert the span.
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n</script>\n` +
        `<Child variant="primary" />\n<Child variant="secondary" />\n`,
      '/Child.svelte':
        `<script>\n  import Heavy from './Heavy.svelte';\n  let { variant = 'other' } = $props();\n</script>\n` +
        `{#if variant === 'primary'}<b>P</b>{:else if variant === 'secondary'}{:else}<Heavy />{/if}\n`,
      '/Heavy.svelte': `<div>HEAVY</div>\n`,
    };
    const plans = await plansFor(files);
    expect(plans.get('/Child.svelte')!.narrow.get('variant')).toEqual(['primary', 'secondary']);

    // shakeSound throws if the transform crashes; the byte oracle proves soundness.
    const out = await shakeSound(files);
    expect(out['/Child.svelte']!).toContain('<Heavy'); // no anchor -> else kept
  });

  it('10: a provably-false head promotes AND the {:else} dies by exhaustiveness', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n</script>\n` +
        `<Child variant="primary" />\n<Child variant="secondary" />\n`,
      '/Child.svelte':
        `<script>\n  import Heavy from './Heavy.svelte';\n  let { variant = 'other' } = $props();\n</script>\n` +
        `{#if variant === 'zzz'}<x>Z</x>` +
        `{:else if variant === 'primary'}<b>P</b>` +
        `{:else if variant === 'secondary'}<em>S</em>` +
        `{:else}<Heavy />{/if}\n`,
      '/Heavy.svelte': `<div>HEAVY</div>\n`,
    };
    const plans = await plansFor(files);
    expect(plans.get('/Child.svelte')!.narrow.get('variant')).toEqual(['primary', 'secondary']);

    const out = await shakeSound(files);
    const child = out['/Child.svelte']!;
    expect(child).not.toContain('<x>Z</x>'); // provably-false head dropped
    expect(child).toContain("{#if variant === 'primary'}"); // arm promoted to head
    expect(child).not.toContain('<Heavy'); // else removed by exhaustiveness
    expect(child).toContain('<em>S</em>');
  });

  it('8: an out-of-set middle arm dies AND the {:else} dies by exhaustiveness together', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n</script>\n` +
        `<Child variant="primary" />\n<Child variant="secondary" />\n`,
      '/Child.svelte':
        `<script>\n  import Heavy from './Heavy.svelte';\n  let { variant = 'other' } = $props();\n</script>\n` +
        `{#if variant === 'primary'}<b>P</b>` +
        `{:else if variant === 'ghost'}<u>G</u>` +
        `{:else if variant === 'secondary'}<em>S</em>` +
        `{:else}<Heavy />{/if}\n`,
      '/Heavy.svelte': `<div>HEAVY</div>\n`,
    };
    const plans = await plansFor(files);
    expect(plans.get('/Child.svelte')!.narrow.get('variant')).toEqual(['primary', 'secondary']);

    const out = await shakeSound(files);
    const child = out['/Child.svelte']!;
    expect(child).not.toContain('<u>G</u>'); // out-of-set 'ghost' arm removed
    expect(child).not.toContain('<Heavy'); // else removed by exhaustiveness
    expect(child).toContain('<b>P</b>');
    expect(child).toContain('<em>S</em>');
  });
});
