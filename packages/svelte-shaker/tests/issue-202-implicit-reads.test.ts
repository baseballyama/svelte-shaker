import { afterAll, describe, expect, it } from 'vitest';
import { svelteShaker } from '../src/index';
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

  it('unfolding one prop re-exposes a read it was hiding (iterates to a fixpoint)', async () => {
    // `a`'s fold would kill the `{#if !a}` arm (`a` is `true`), but `a` is itself
    // read by `use:a` at top level, so it unfolds; the arm then lives, exposing
    // `<b.Root/>`, so `b` (never passed) must unfold too.
    const out = await shakeSound({
      '/App.svelte': `<script>\n  ${IMPORT_CHILD}\n</script>\n<Child a={true} />\n`,
      '/Child.svelte':
        `<script>\n  let { a, b } = $props();\n</script>\n` +
        `<div use:a>hi</div>{#if !a}<b.Root />{/if}\n`,
    });
    expect(out['/Child.svelte']).toContain('let { a, b } = $props();');
  });
});
