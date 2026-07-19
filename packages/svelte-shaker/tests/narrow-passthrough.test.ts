import { afterAll, describe, expect, it } from 'vitest';
import { svelteShaker } from '../src/index';
import { analyze } from '../src/analyze';
import { shakeWithRevertCascade } from '../src/revert-cascade';
import { transformAll } from '../src/transform';
import { assertCompiles, cleanTmp, renderGraphHtml } from './diff';

afterAll(() => cleanTmp());

// ----------------------------------------------------------------------
// Interprocedural pass-through of a value SET (docs §13.1, PR6).
//
// PR #105 forwarded a single folded constant across a pass-through call site.
// This extends that to a NARROW set: when an owner's prop is narrowed to a known
// reachable set (`variant ∈ {primary, secondary}`) and forwarded verbatim
// (`<Child variant={variant}/>`), the whole set flows into the child, so the
// child's own value-set narrowing (dead `{#if}` arms, dead `<style>` rules) fires
// across the component boundary. Only a BARE owner-prop reference propagates a
// set; any compound expression stays dynamic (mirrors css.ts `expressionStrings`).
//
// Each probe builds an in-memory App -> … -> leaf graph, runs the real engine,
// and asserts BOTH the narrowing where expected AND byte-equal SSR HTML (oracle).
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

describe('interprocedural pass-through of value sets', () => {
  it('2-stage: an owner-narrowed set flows to Child and prunes the unreachable arm + CSS rule', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Mid from './Mid.svelte';\n</script>\n` +
        `<Mid variant="primary" />\n<Mid variant="secondary" />\n`,
      '/Mid.svelte':
        `<script>\n  import Child from './Child.svelte';\n  let { variant } = $props();\n</script>\n` +
        `<Child variant={variant} />\n`,
      '/Child.svelte':
        `<script>\n  let { variant = 'other' } = $props();\n</script>\n` +
        `<div class="btn btn-{variant}">\n` +
        `{#if variant === 'primary'}<b>P</b>{:else if variant === 'secondary'}<em>S</em>{:else if variant === 'danger'}<strong>D</strong>{/if}\n` +
        `</div>\n` +
        `<style>\n  .btn-danger { color: red; }\n  .btn-primary { color: blue; }\n</style>\n`,
    };
    const plans = await plansFor(files);
    // The set — not a single constant — reaches Child across the boundary.
    expect(plans.get('/Child.svelte')!.constFold.has('variant')).toBe(false);
    expect(plans.get('/Child.svelte')!.narrow.get('variant')).toEqual(['primary', 'secondary']);

    const out = await shakeSound(files);
    const child = out['/Child.svelte']!;
    expect(child).toMatch(/let \{ variant/); // narrow keeps the prop genuinely used
    expect(child).not.toContain('danger'); // the unreachable arm AND its CSS rule are gone
    expect(child).toContain('btn-primary'); // a reachable rule stays
  });

  it('3-stage: the set travels two pass-through hops down to the leaf', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import A from './A.svelte';\n</script>\n` +
        `<A v="go" />\n<A v="wait" />\n`,
      '/A.svelte':
        `<script>\n  import B from './B.svelte';\n  let { v } = $props();\n</script>\n<B v={v} />\n`,
      '/B.svelte':
        `<script>\n  import C from './C.svelte';\n  let { v } = $props();\n</script>\n<C v={v} />\n`,
      '/C.svelte':
        `<script>\n  let { v = 'stop' } = $props();\n</script>\n` +
        `{#if v === 'go'}<b>GO</b>{:else if v === 'wait'}<em>W</em>{:else if v === 'stop'}<i>S</i>{/if}\n`,
    };
    const plans = await plansFor(files);
    expect(plans.get('/C.svelte')!.narrow.get('v')).toEqual(['go', 'wait']);

    const out = await shakeSound(files);
    expect(out['/C.svelte']!).not.toContain("'stop'"); // the unreachable default arm is gone
    expect(out['/C.svelte']!).toContain('<b>GO</b>');
  });

  it('mixed: a forwarded set unions with a sibling literal call site', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Mid from './Mid.svelte';\n</script>\n` +
        `<Mid variant="primary" />\n<Mid variant="secondary" />\n`,
      '/Mid.svelte':
        `<script>\n  import Child from './Child.svelte';\n  let { variant } = $props();\n</script>\n` +
        `<Child variant={variant} />\n<Child variant="ghost" />\n`,
      '/Child.svelte':
        `<script>\n  let { variant = 'other' } = $props();\n</script>\n` +
        `{#if variant === 'primary'}<b>P</b>{:else if variant === 'secondary'}<em>S</em>{:else if variant === 'ghost'}<u>G</u>{:else if variant === 'danger'}<strong>D</strong>{/if}\n`,
    };
    const plans = await plansFor(files);
    // {primary, secondary} (forwarded set) ∪ {ghost} (sibling literal).
    expect(plans.get('/Child.svelte')!.narrow.get('variant')).toEqual([
      'primary',
      'secondary',
      'ghost',
    ]);

    const out = await shakeSound(files);
    expect(out['/Child.svelte']!).toContain('<u>G</u>'); // ghost stays reachable
    expect(out['/Child.svelte']!).not.toContain('danger'); // danger is unreachable -> dropped
  });

  it('conservative: a compound expression over a set-var does NOT propagate', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Mid from './Mid.svelte';\n</script>\n` +
        `<Mid variant="primary" />\n<Mid variant="secondary" />\n`,
      '/Mid.svelte':
        `<script>\n  import Child from './Child.svelte';\n  let { variant } = $props();\n</script>\n` +
        `<Child v={variant + ''} />\n`,
      '/Child.svelte':
        `<script>\n  let { v = 'other' } = $props();\n</script>\n` +
        `{#if v === 'primary'}<b>P</b>{:else if v === 'danger'}<strong>D</strong>{:else}<i>{v}</i>{/if}\n`,
    };
    const plans = await plansFor(files);
    // `variant + ''` is not a bare identifier -> the set does not flow; v stays dynamic.
    expect(plans.get('/Child.svelte')!.narrow.has('v')).toBe(false);
    expect(plans.get('/Child.svelte')!.constFold.has('v')).toBe(false);

    const out = await shakeSound(files);
    expect(out['/Child.svelte']!).toContain('danger'); // arm kept: value unknown
    expect(out['/Child.svelte']!).toMatch(/let \{ v/);
  });

  it('shadow guard: an `{#each as variant}` binding forwarded to Child does not propagate', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Mid from './Mid.svelte';\n</script>\n` +
        `<Mid variant="primary" items={['primary', 'secondary']} />\n` +
        `<Mid variant="secondary" items={['primary', 'secondary']} />\n`,
      '/Mid.svelte':
        `<script>\n  import Child from './Child.svelte';\n  let { variant, items = [] } = $props();\n</script>\n` +
        `{#each items as variant}<Child v={variant} />{/each}\n`,
      '/Child.svelte':
        `<script>\n  let { v = 'other' } = $props();\n</script>\n` +
        `{#if v === 'primary'}<b>P</b>{:else if v === 'danger'}<strong>D</strong>{:else}<i>{v}</i>{/if}\n`,
    };
    const plans = await plansFor(files);
    // `variant` is rebound by `{#each as variant}` in Mid, so it is never narrowed
    // there; the forwarded value is the loop element, unknown at build time.
    expect(plans.get('/Mid.svelte')!.narrow.has('variant')).toBe(false);
    expect(plans.get('/Child.svelte')!.narrow.has('v')).toBe(false);

    const out = await shakeSound(files);
    expect(out['/Child.svelte']!).toContain('danger'); // kept: dynamic loop element
  });

  it('written guard: a reassigned owner prop forwarded to Child does not propagate', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Mid from './Mid.svelte';\n</script>\n` +
        `<Mid variant="primary" />\n<Mid variant="secondary" />\n`,
      '/Mid.svelte':
        `<script>\n  import Child from './Child.svelte';\n  let { variant } = $props();\n  variant = 'danger';\n</script>\n` +
        `<Child v={variant} />\n`,
      '/Child.svelte':
        `<script>\n  let { v = 'other' } = $props();\n</script>\n` +
        `{#if v === 'primary'}<b>P</b>{:else if v === 'danger'}<strong>D</strong>{:else}<i>{v}</i>{/if}\n`,
    };
    const plans = await plansFor(files);
    // Mid writes `variant`, so it is not a stable set -> never narrowed, never forwarded.
    expect(plans.get('/Mid.svelte')!.narrow.has('variant')).toBe(false);
    expect(plans.get('/Child.svelte')!.narrow.has('v')).toBe(false);

    const out = await shakeSound(files);
    expect(out['/Child.svelte']!).toContain('danger');
  });

  it('spread poison: an explicit forward BEFORE an unknown spread stays ⊤ (no propagation)', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Mid from './Mid.svelte';\n</script>\n` +
        `<Mid variant="primary" />\n<Mid variant="secondary" />\n`,
      '/Mid.svelte':
        `<script>\n  import Child from './Child.svelte';\n  let { variant, ...rest } = $props();\n</script>\n` +
        `<Child variant={variant} {...rest} />\n`,
      '/Child.svelte':
        `<script>\n  let { variant = 'other' } = $props();\n</script>\n` +
        `{#if variant === 'primary'}<b>P</b>{:else if variant === 'danger'}<strong>D</strong>{:else}<i>{variant}</i>{/if}\n`,
    };
    const plans = await plansFor(files);
    // The spread after the explicit could override `variant`, so the value set is
    // ⊤ (top): neither folded nor narrowed, even though the set is forwarded.
    expect(plans.get('/Child.svelte')!.narrow.has('variant')).toBe(false);
    expect(plans.get('/Child.svelte')!.valueSets.get('variant')!.top).toBe(true);

    const out = await shakeSound(files);
    expect(out['/Child.svelte']!).toContain('danger'); // arm kept
  });
});

// ----------------------------------------------------------------------
// The revert cascade must RECOMPUTE the fixpoint after force-bailing, not just
// patch the bailed component's plan.  With set pass-through a child's NARROWING
// depends on its owner's narrow set, so force-bailing the OWNER must un-narrow the
// child too — otherwise the child keeps a `{#if}` arm dropped and a `<style>` rule
// removed on the strength of a set the reverted owner no longer provides.  This
// drives the cascade directly with a fault-injecting transform (the narrow analog
// of the pass-through cascade test).
// ----------------------------------------------------------------------

describe('revert cascade recomputes pass-through value sets', () => {
  it('force-bailing a forwarding owner un-narrows the child so its dropped arm revives', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Mid from './Mid.svelte';\n</script>\n` +
        `<Mid variant="primary" />\n<Mid variant="secondary" />\n`,
      '/Mid.svelte':
        `<script>\n  import Child from './Child.svelte';\n  let { variant } = $props();\n</script>\n` +
        `<Child variant={variant} />\n`,
      '/Child.svelte':
        `<script>\n  let { variant = 'other' } = $props();\n</script>\n` +
        `{#if variant === 'primary'}<b>P</b>{:else if variant === 'secondary'}<em>S</em>{:else if variant === 'danger'}<strong>D</strong>{/if}\n`,
    };
    const { resolve, readFile } = memGraph(files);
    const { models, plans } = await analyze('/App.svelte', resolve, readFile);
    // Without a fault, the pass-through narrows Child.variant and drops `danger`.
    expect(plans.get('/Child.svelte')!.narrow.get('variant')).toEqual(['primary', 'secondary']);

    let pass = 0;
    const out = shakeWithRevertCascade(models, plans, (p) => {
      const result = transformAll(models, p);
      // Fault-inject: Mid's first (folded) output is unparseable, forcing a revert.
      if (pass++ === 0) result['/Mid.svelte'] = '<script>\n  let x = ;\n</script>\n';
      return result;
    });

    // Mid reverted to its original; because the fixpoint was RECOMPUTED, Child
    // un-narrowed too and keeps every arm, so the `danger` arm is back.
    expect(out['/Mid.svelte']).toBe(files['/Mid.svelte']);
    expect(out['/Child.svelte']).toContain('danger');

    // The whole graph still renders identically to the untouched original.
    const before = await graphHtml(files);
    const after = await graphHtml({ ...files, ...out });
    expect(after).toBe(before);
  });
});
