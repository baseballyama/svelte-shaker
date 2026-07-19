import { afterAll, describe, expect, it } from 'vitest';
import { svelteShaker } from '../src/index';
import { analyze } from '../src/analyze';
import { shakeWithRevertCascade } from '../src/revert-cascade';
import { transformAll } from '../src/transform';
import { assertCompiles, cleanTmp, renderGraphHtml } from './diff';

afterAll(() => cleanTmp());

// ----------------------------------------------------------------------
// Interprocedural pass-through of a folded constant (docs §13.1).
//
// A prop the whole app passes a single value gets folded in its OWNING
// component; when that component then forwards it (`<Child prop={prop}/>`), the
// call-site expression should be evaluated against the owner's fold env so the
// CHILD folds too — the residual owner really passes `<Child prop={"lit"}/>`.
//
// Each probe builds an in-memory App -> … -> leaf graph, runs the real engine,
// and asserts BOTH that the fold happened where expected AND that the whole
// program still server-renders identical HTML (the soundness oracle).
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

describe('interprocedural pass-through of folded constants', () => {
  it('2-stage: App -> Mid -> Child folds the forwarded prop and removes the attribute', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Mid from './Mid.svelte';\n</script>\n` + `<Mid variant="primary" />\n`,
      '/Mid.svelte':
        `<script>\n  import Child from './Child.svelte';\n  let { variant } = $props();\n</script>\n` +
        `<Child variant={variant} />\n`,
      '/Child.svelte':
        `<script>\n  let { variant = 'other' } = $props();\n</script>\n` +
        `{#if variant === 'primary'}<b>P</b>{:else if variant === 'danger'}<strong>D</strong>{:else}<i>o</i>{/if}\n`,
    };
    const plans = await plansFor(files);
    expect(plans.get('/Child.svelte')!.constFold.get('variant')).toBe('primary');

    const out = await shakeSound(files);
    const child = out['/Child.svelte']!;
    const mid = out['/Mid.svelte']!;
    expect(child).not.toMatch(/let \{ variant/); // dropped from signature
    expect(child).toContain('<b>P</b>');
    expect(child).not.toContain('danger');
    // Mid folded its own `variant` AND forwards nothing now: `<Child />`.
    expect(mid).not.toContain('variant=');
  });

  it('3-stage: App -> A -> B -> C folds all the way down', async () => {
    const files = {
      '/App.svelte': `<script>\n  import A from './A.svelte';\n</script>\n` + `<A v="go" />\n`,
      '/A.svelte': `<script>\n  import B from './B.svelte';\n  let { v } = $props();\n</script>\n<B v={v} />\n`,
      '/B.svelte': `<script>\n  import C from './C.svelte';\n  let { v } = $props();\n</script>\n<C v={v} />\n`,
      '/C.svelte':
        `<script>\n  let { v = 'stop' } = $props();\n</script>\n` +
        `{#if v === 'go'}<b>GO</b>{:else}<i>stop</i>{/if}\n`,
    };
    const plans = await plansFor(files);
    expect(plans.get('/C.svelte')!.constFold.get('v')).toBe('go');

    const out = await shakeSound(files);
    expect(out['/C.svelte']!).toContain('<b>GO</b>');
    expect(out['/C.svelte']!).not.toContain('stop</i>');
  });

  it('convergent: two call sites of Mid pass the SAME literal -> Child folds', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Mid from './Mid.svelte';\n</script>\n` +
        `<Mid variant="primary" />\n<Mid variant="primary" />\n`,
      '/Mid.svelte':
        `<script>\n  import Child from './Child.svelte';\n  let { variant } = $props();\n</script>\n` +
        `<Child variant={variant} />\n`,
      '/Child.svelte':
        `<script>\n  let { variant = 'other' } = $props();\n</script>\n` +
        `{#if variant === 'primary'}<b>P</b>{:else}<i>o</i>{/if}\n`,
    };
    const plans = await plansFor(files);
    expect(plans.get('/Child.svelte')!.constFold.get('variant')).toBe('primary');
    const out = await shakeSound(files);
    expect(out['/Child.svelte']!).not.toMatch(/let \{ variant/);
  });

  it('divergent: two call sites pass DIFFERENT literals -> Mid narrows, Child does not fold', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Mid from './Mid.svelte';\n</script>\n` +
        `<Mid variant="primary" />\n<Mid variant="secondary" />\n`,
      '/Mid.svelte':
        `<script>\n  import Child from './Child.svelte';\n  let { variant } = $props();\n</script>\n` +
        `<Child variant={variant} />\n`,
      '/Child.svelte':
        `<script>\n  let { variant = 'other' } = $props();\n</script>\n` +
        `{#if variant === 'primary'}<b>P</b>{:else if variant === 'secondary'}<em>S</em>{:else}<i>o</i>{/if}\n`,
    };
    const plans = await plansFor(files);
    // Mid.variant is a known set of two literals (narrow), not a single constant.
    expect(plans.get('/Mid.svelte')!.constFold.has('variant')).toBe(false);
    expect(plans.get('/Mid.svelte')!.narrow.get('variant')).toEqual(['primary', 'secondary']);
    // Set (narrow) propagation is out of scope: Child sees a dynamic value.
    expect(plans.get('/Child.svelte')!.constFold.has('variant')).toBe(false);

    const out = await shakeSound(files);
    expect(out['/Child.svelte']!).toMatch(/let \{ variant/); // kept: still dynamic
  });

  it('ternary call-site expression folds when its condition is a folded prop', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Mid from './Mid.svelte';\n</script>\n` + `<Mid variant="primary" />\n`,
      '/Mid.svelte':
        `<script>\n  import Child from './Child.svelte';\n  let { variant } = $props();\n</script>\n` +
        `<Child v={variant === 'primary' ? 'x' : 'y'} />\n`,
      '/Child.svelte':
        `<script>\n  let { v = 'z' } = $props();\n</script>\n` +
        `{#if v === 'x'}<b>X</b>{:else}<i>{v}</i>{/if}\n`,
    };
    const plans = await plansFor(files);
    expect(plans.get('/Child.svelte')!.constFold.get('v')).toBe('x');
    const out = await shakeSound(files);
    expect(out['/Child.svelte']!).toContain('<b>X</b>');
  });

  it('shadow guard: an `{#each as variant}` binding forwarded to Child does not fold', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Mid from './Mid.svelte';\n</script>\n` +
        `<Mid variant="primary" items={['primary', 'secondary']} />\n`,
      '/Mid.svelte':
        `<script>\n  import Child from './Child.svelte';\n  let { variant, items = [] } = $props();\n</script>\n` +
        `{#each items as variant}<Child v={variant} />{/each}\n`,
      '/Child.svelte':
        `<script>\n  let { v = 'other' } = $props();\n</script>\n` +
        `{#if v === 'primary'}<b>P</b>{:else}<i>{v}</i>{/if}\n`,
    };
    const plans = await plansFor(files);
    // `variant` is rebound by `{#each as variant}` in Mid, so it is never folded
    // there; the forwarded value is the loop element, unknown at build time.
    expect(plans.get('/Mid.svelte')!.constFold.has('variant')).toBe(false);
    expect(plans.get('/Child.svelte')!.constFold.has('v')).toBe(false);

    const out = await shakeSound(files);
    expect(out['/Child.svelte']!).toMatch(/let \{ v/); // kept: values are 'primary','secondary'
  });

  it('written guard: a reassigned owner prop forwarded to Child does not fold', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Mid from './Mid.svelte';\n</script>\n` + `<Mid variant="primary" />\n`,
      '/Mid.svelte':
        `<script>\n  import Child from './Child.svelte';\n  let { variant } = $props();\n  variant = 'secondary';\n</script>\n` +
        `<Child v={variant} />\n`,
      '/Child.svelte':
        `<script>\n  let { v = 'other' } = $props();\n</script>\n` +
        `{#if v === 'primary'}<b>P</b>{:else if v === 'secondary'}<em>S</em>{:else}<i>o</i>{/if}\n`,
    };
    const plans = await plansFor(files);
    // Mid writes `variant`, so it is not a constant -> never folded, never forwarded.
    expect(plans.get('/Mid.svelte')!.constFold.has('variant')).toBe(false);
    expect(plans.get('/Child.svelte')!.constFold.has('v')).toBe(false);

    const out = await shakeSound(files);
    expect(out['/Child.svelte']!).toMatch(/let \{ v/);
  });

  it('pure literal call-site expression folds with no owner env at all', async () => {
    const files = {
      '/App.svelte': `<script>\n  import Mid from './Mid.svelte';\n</script>\n` + `<Mid />\n`,
      '/Mid.svelte':
        `<script>\n  import Child from './Child.svelte';\n</script>\n` +
        `<Child v={'a' + 'b'} />\n`,
      '/Child.svelte':
        `<script>\n  let { v = 'z' } = $props();\n</script>\n` +
        `{#if v === 'ab'}<b>AB</b>{:else}<i>{v}</i>{/if}\n`,
    };
    const plans = await plansFor(files);
    expect(plans.get('/Child.svelte')!.constFold.get('v')).toBe('ab');
    const out = await shakeSound(files);
    expect(out['/Child.svelte']!).toContain('<b>AB</b>');
  });
});

// ----------------------------------------------------------------------
// The revert cascade must RECOMPUTE the fixpoint after force-bailing, not just
// patch the bailed component's plan.  With pass-through (docs §13.1) a child's
// fold can depend on its owner's fold, so if a transform bug forces the OWNER to
// revert, the child must un-fold too — otherwise the reverted owner keeps
// forwarding an attribute for a prop the child dropped, which then flows into the
// child's `...rest` and changes what renders (unsound).  This drives the cascade
// directly with a fault-injecting transform (the engine has no natural trigger).
// ----------------------------------------------------------------------

describe('revert cascade recomputes pass-through folds', () => {
  it('force-bailing a forwarding owner un-folds the child so its ...rest stays sound', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Mid from './Mid.svelte';\n</script>\n` + `<Mid variant="primary" />\n`,
      '/Mid.svelte':
        `<script>\n  import Child from './Child.svelte';\n  let { variant } = $props();\n</script>\n` +
        `<Child v={variant} />\n`,
      // `...rest` captures every prop NOT declared. If `v` is (unsoundly) dropped
      // while Mid still forwards it, `v` leaks into `rest` and this line changes.
      '/Child.svelte':
        `<script>\n  let { v = 'default', ...rest } = $props();\n</script>\n` +
        `<p>v:{v}</p><p>rest:{Object.keys(rest).join(',')}</p>\n`,
    };
    const { resolve, readFile } = memGraph(files);
    const { models, plans } = await analyze('/App.svelte', resolve, readFile);
    // Without a fault, the pass-through folds Child.v (and would drop it).
    expect(plans.get('/Child.svelte')!.constFold.get('v')).toBe('primary');

    let pass = 0;
    const out = shakeWithRevertCascade(models, plans, (p) => {
      const result = transformAll(models, p);
      // Fault-inject: Mid's first (folded) output is unparseable, forcing a revert.
      if (pass++ === 0) result['/Mid.svelte'] = '<script>\n  let x = ;\n</script>\n';
      return result;
    });

    // Mid reverted to its original; because the fixpoint was RECOMPUTED (not just
    // patched), Child un-folded too and keeps `v` declared, so the forwarded `v`
    // binds to the prop rather than to `...rest`.
    expect(out['/Mid.svelte']).toBe(files['/Mid.svelte']);
    expect(out['/Child.svelte']).toMatch(/let \{ v = 'default', \.\.\.rest \}/);

    // The whole graph still renders identically to the untouched original.
    const before = await graphHtml(files);
    const after = await graphHtml({ ...files, ...out });
    expect(after).toBe(before);
  });
});
