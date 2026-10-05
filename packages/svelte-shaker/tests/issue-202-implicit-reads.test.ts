import { afterAll, describe, expect, it } from 'vitest';
import { svelteShaker } from '../src/index';
import { analyze, plansEqual, refinePlans } from '../src/analyze';
import { monomorphize } from '../src/mono';
import { assertCompiles, cleanTmp, renderGraphHtml } from './diff';
import { memGraph } from './mem-graph';

afterAll(() => cleanTmp());

// ----------------------------------------------------------------------
// Regression: issue #202 — a prop read only through a position that is not an
// expression identifier was classified as unread, so its `$props()` declaration
// was dropped and the read left dangling:
//  - a store auto-subscription `$name` (the identifier is `$name`, the binding
//    read is `name`) -> `global_reference_invalid` compile error;
//  - a `style:name` shorthand directive (no expression node) -> `name is not
//    defined` when the caller passes a non-constant value;
//  - a component tag `<name/>` / `<name.Member/>` (the tag name is a string) ->
//    `name is not defined`;
//  - an action / transition / animation directive `use:name` / `transition:` /
//    `in:` / `out:` / `animate:` (also a string name) -> `name is not defined` in
//    the client build (SSR skips directives, so only the declaration check sees it).
// None of these positions can take a substituted literal either, so such a prop
// must not FOLD (dropping the declaration) even when every call site agrees —
// except `style:name`, which the substitution expands to `style:name={lit}`.
//
// Every probe runs the real engine over an in-memory graph and asserts the whole
// program still server-renders identical HTML (the soundness oracle).
// ----------------------------------------------------------------------

/** Render the whole `/App.svelte` graph (flat `/X.svelte` ids) to HTML. */
async function graphHtml(files: Record<string, string>): Promise<string> {
  const deps: Record<string, string> = {};
  for (const [id, src] of Object.entries(files)) {
    if (id === '/App.svelte') continue;
    deps[`.${id}`] = src; // `/Child.svelte` -> `./Child.svelte`
  }
  return renderGraphHtml({ specifier: './App.svelte', source: files['/App.svelte']! }, deps, {});
}

/**
 * Shake `files` from `/App.svelte`, assert every shaken file compiles and the
 * whole graph renders identical HTML before/after, and return the shaken sources
 * merged over the originals.
 */
async function shakeSound(files: Record<string, string>): Promise<Record<string, string>> {
  const { resolve, readFile } = memGraph(files);
  const out = await svelteShaker('/App.svelte', resolve, readFile);
  const merged = { ...files, ...out };
  for (const [id, src] of Object.entries(out))
    assertCompiles(src, id.slice(id.lastIndexOf('/') + 1));
  expect(await graphHtml(merged)).toBe(await graphHtml(files));
  return merged;
}

const IMPORT_CHILD = `import Child from './Child.svelte';`;

describe('issue #202: props read implicitly are kept', () => {
  it('a `$store` auto-subscription in the template reads the prop', async () => {
    const out = await shakeSound({
      '/App.svelte':
        `<script>\n  ${IMPORT_CHILD}\n  import { writable } from 'svelte/store';\n` +
        `  const store = writable({ current: 42 });\n</script>\n<Child progressStore={store} />\n`,
      '/Child.svelte':
        `<script>\n  let { progressStore } = $props();\n</script>\n` +
        `<p>{$progressStore.current}</p>\n`,
    });
    expect(out['/Child.svelte']).toContain('let { progressStore } = $props();');
    expect(out['/App.svelte']).toContain('<Child progressStore={store} />');
  });

  it('a `$store` auto-subscription in the script reads the prop', async () => {
    const out = await shakeSound({
      '/App.svelte':
        `<script>\n  ${IMPORT_CHILD}\n  import { writable } from 'svelte/store';\n` +
        `  const store = writable(7);\n</script>\n<Child count={store} />\n`,
      '/Child.svelte':
        `<script>\n  let { count } = $props();\n  const doubled = $derived($count * 2);\n</script>\n` +
        `<p>{doubled}</p>\n`,
    });
    expect(out['/Child.svelte']).toContain('let { count } = $props();');
  });

  it('a rune-named `$state` is a store read of a `state` prop (store_rune_conflict)', async () => {
    // With a `state` binding in scope the compiler reads `$state(…)` as a
    // subscription to it, not as the rune — so `state` is read, even though it is
    // never passed (a never-passed prop would otherwise fold to `undefined`).
    const out = await shakeSound({
      '/App.svelte':
        `<script>\n  ${IMPORT_CHILD}\n  import { readable } from 'svelte/store';\n` +
        `  const s = readable((n) => n + 1);\n</script>\n<Child state={s} />\n`,
      '/Child.svelte': `<script>\n  let { state } = $props();\n  const x = $state(1);\n</script>\n<p>{x}</p>\n`,
    });
    expect(out['/Child.svelte']).toContain('let { state } = $props();');
  });

  it('a `style:name` shorthand reads a dynamically passed prop', async () => {
    const out = await shakeSound({
      '/App.svelte': `<script>\n  ${IMPORT_CHILD}\n  let { w = '42px' } = $props();\n</script>\n<Child width={w} />\n`,
      '/Child.svelte':
        `<script>\n  let { width = '100%' } = $props();\n</script>\n` +
        `<div style:width>hello</div>\n`,
    });
    expect(out['/Child.svelte']).toContain(`let { width = '100%' } = $props();`);
    expect(out['/App.svelte']).toContain('<Child width={w} />');
  });

  it('a `style:name` shorthand with a constant prop still folds (control)', async () => {
    const out = await shakeSound({
      '/App.svelte': `<script>\n  ${IMPORT_CHILD}\n</script>\n<Child width="42px" />\n`,
      '/Child.svelte':
        `<script>\n  let { width = '100%' } = $props();\n</script>\n` +
        `<div style:width>hello</div>\n`,
    });
    expect(out['/Child.svelte']).toContain('<div style:width={"42px"}>hello</div>');
    expect(out['/Child.svelte']).not.toContain('$props');
  });

  it('a member component tag `<name.Root/>` reads the prop', async () => {
    const out = await shakeSound({
      '/App.svelte':
        `<script>\n  ${IMPORT_CHILD}\n  import Leaf from './Leaf.svelte';\n` +
        `  const controls = { Root: Leaf };\n</script>\n<Child component={controls} />\n`,
      '/Child.svelte': `<script>\n  let { component } = $props();\n</script>\n<component.Root />\n`,
      '/Leaf.svelte': `<p>leaf</p>\n`,
    });
    expect(out['/Child.svelte']).toContain('let { component } = $props();');
  });

  it('a component tag `<Name/>` reads the prop', async () => {
    const out = await shakeSound({
      '/App.svelte': `<script>\n  ${IMPORT_CHILD}\n  import Leaf from './Leaf.svelte';\n</script>\n<Child Icon={Leaf} />\n`,
      '/Child.svelte': `<script>\n  let { Icon } = $props();\n</script>\n<Icon />\n`,
      '/Leaf.svelte': `<p>leaf</p>\n`,
    });
    expect(out['/Child.svelte']).toContain('let { Icon } = $props();');
  });

  it.each([
    ['use:', '<div use:x>hi</div>'],
    ['use: (member)', '<div use:x.run>hi</div>'],
    ['transition:', '<div transition:x>hi</div>'],
    ['in:', '<div in:x>hi</div>'],
    ['out:', '<div out:x>hi</div>'],
    ['animate:', '{#each [1] as i (i)}<div animate:x>hi</div>{/each}'],
  ])('a `%s` directive name reads the prop', async (_label, markup) => {
    const out = await shakeSound({
      '/App.svelte': `<script>\n  ${IMPORT_CHILD}\n  const fn = () => ({});\n  fn.run = fn;\n</script>\n<Child x={fn} />\n`,
      '/Child.svelte': `<script>\n  let { x } = $props();\n</script>\n${markup}\n`,
    });
    expect(out['/Child.svelte']).toContain('let { x } = $props();');
    expect(out['/App.svelte']).toContain('<Child x={fn} />');
  });

  it('a never-passed prop read implicitly outside a dead branch is not folded', async () => {
    // A never-passed prop has the single value `undefined`, but `$s` admits no
    // literal, so folding would drop the declaration and dangle the read.
    const out = await shakeSound({
      '/App.svelte': `<script>\n  ${IMPORT_CHILD}\n</script>\n<Child />\n`,
      '/Child.svelte': `<script>\n  let { s } = $props();\n</script>\n<p>{$s}</p>\n`,
    });
    expect(out['/Child.svelte']).toContain('let { s } = $props();');
  });

  it('a never-passed prop read implicitly only inside its own dead branch still folds', async () => {
    // `{#if c}` with `c` folded to `undefined` deletes the arm holding every
    // implicit read, so nothing dangles and the fold (and the drop) stay sound.
    const out = await shakeSound({
      '/App.svelte': `<script>\n  ${IMPORT_CHILD}\n</script>\n<Child />\n`,
      '/Child.svelte':
        `<script>\n  let { s, c, a } = $props();\n</script>\n` +
        `<b>x</b>{#if s}<p>{$s}</p>{/if}{#if c}<c.Root />{/if}{#if a}<div use:a>hi</div>{/if}\n`,
    });
    expect(out['/Child.svelte']).not.toContain('$props');
    expect(out['/Child.svelte']).not.toContain('{#if');
  });

  it('a demoted constant still kills the branches its value excludes', async () => {
    // `s` (never passed) and `a` are constants read implicitly at top level, so
    // they stay declared — but as one-value narrow sets they still delete the
    // `{#if}` arms their value rules out.  `b`'s only implicit read sits in such an
    // arm, so `b` folds and is dropped.
    const out = await shakeSound({
      '/App.svelte': `<script>\n  ${IMPORT_CHILD}\n</script>\n<Child a={true} />\n`,
      '/Child.svelte':
        `<script>\n  let { a, b, s } = $props();\n</script>\n` +
        `<div use:a>hi</div>{#if !a}<b.Root />{/if}{#if s === 5}<em>five</em>{/if}<p>{$s}</p>\n`,
    });
    const child = out['/Child.svelte']!;
    expect(child).toContain('let { a, s } = $props();');
    expect(child).not.toContain('{#if');
    expect(child).toContain('<p>{$s}</p>');
  });

  it('the fixpoint converges when a demoted constant would otherwise revive a call site', async () => {
    // `act` in B narrows to {null, undefined}, then collapses to `undefined` once
    // A's `x === 2` arm dies; `use:act` is live, so it is demoted.  Kept as a
    // one-value set it still kills `{#if act === 5}`; dropping the value instead
    // revived `<A x={2}/>`, re-widened `x`, and the plans cycled until the cap.
    const files = {
      '/App.svelte': `<script>import A from './A.svelte'; import B from './B.svelte'; let { f = false } = $props();</script><A x={1} /><B flag={f} />`,
      '/A.svelte': `<script>import B from './B.svelte'; let { x } = $props();</script><p>A{x}</p>{#if x === 2}<B act={null} />{/if}`,
      '/B.svelte': `<script>import A from './A.svelte'; let { act, flag } = $props();</script>{#if flag}<div use:act>x</div>{/if}{#if act === 5}<A x={2} />{/if}<i>B</i>`,
    };
    const { resolve, readFile } = memGraph(files);
    const { models, plans } = await analyze('/App.svelte', resolve, readFile);
    expect(plansEqual(plans, refinePlans(models, plans))).toBe(true);
    expect(plans.get('/B.svelte')!.narrow.get('act')).toEqual([undefined]);
    expect(plans.get('/A.svelte')!.constFold.get('x')).toBe(1);
    const out = await shakeSound(files);
    expect(out['/B.svelte']).not.toContain('act === 5');
  });

  it('a demoted constant forwarded to a child is removed with the prop it folds', async () => {
    // Mid's `s` is demoted to the one-value set {"a"}, so Grand receives exactly
    // "a" and folds `v`.  Phase 2 must then remove `v={s}` too: left in place, it
    // would land in Grand's `...rest` and render as `<p v="a">`.
    const out = await shakeSound({
      '/App.svelte': `<script>import Mid from './Mid.svelte'; let { f = false } = $props();</script><Mid s="a" flag={f} />`,
      '/Mid.svelte': `<script>import Grand from './Grand.svelte'; let { s, flag } = $props();</script>{#if flag}<div use:s>x</div>{/if}<Grand v={s} />`,
      '/Grand.svelte': `<script>let { v, ...rest } = $props();</script><p {...rest}>{v}</p>`,
    });
    expect(out['/Mid.svelte']).toContain('<Grand />');
    expect(out['/Grand.svelte']).toContain('<p {...rest}>{"a"}</p>');
  });

  it('never specializes a child whose app-wide fold hides an implicit read', async () => {
    // The base deletes `{#if s}{$s}{/if}` (s never passed) inside the live
    // `{#if a === 0}` arm.  A variant freezing `a = 0` re-emits that arm verbatim,
    // which would leave `{$s}` behind with `s` dropped — so the child is ineligible.
    // The size measure prices every variant at 0 so only that guard can decline.
    const files = {
      '/App.svelte': `<script>\n  ${IMPORT_CHILD}\n</script>\n<Child a={0} /><Child a={1} />\n`,
      '/Child.svelte':
        `<script>\n  let { a, s } = $props();\n</script>\n` +
        `{#if a === 0}<i>zero</i>{#if s}{$s}{/if}{/if}<b>{a}</b>\n`,
    };
    const { resolve, readFile } = memGraph(files);
    const { models, plans } = await analyze('/App.svelte', resolve, readFile);
    expect(plans.get('/Child.svelte')!.constFold.has('s')).toBe(true);
    const sizeVariantsFree = (id: string, source: string): number =>
      id.includes('::v') ? 0 : source.length;
    const res = monomorphize(
      models,
      plans,
      { enabled: true, maxVariants: 8, minSavings: 0 },
      '/App.svelte',
      sizeVariantsFree,
    );
    expect(res.variants.size).toBe(0);
  });
});
