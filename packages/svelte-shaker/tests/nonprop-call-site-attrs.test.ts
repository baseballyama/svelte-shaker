import { afterAll, describe, expect, it } from 'vitest';
import { svelteShaker } from '../src/index';
import { assertCompiles, cleanTmp, renderGraphHtml } from './diff';
import { memGraph } from './mem-graph';

afterAll(() => cleanTmp());

// ----------------------------------------------------------------------
// Non-prop call-site attributes.  Svelte's parser turns only the KNOWN directive
// prefixes (`bind:`/`on:`/`use:`/…) into typed directive nodes; a `--css-var` and
// an attribute in a namespace svelte does not define (`<Widget my:directive/>`)
// both stay plain `Attribute` nodes.  Neither is a prop the child can read, so
// the reverse pass must not treat them as dead inputs and delete them.
//
// `--css-var` is the SSR-observable one: svelte compiles it to `$.css_props(...)`,
// which renders a `<svelte-css-wrapper>` element — so the differential-SSR oracle
// in `shakeSound` is the real assertion there.  An unknown namespace renders
// nothing, so its test is about source fidelity: the marker must survive for the
// preprocessor that consumes it, WITHOUT the component losing its prop folding.
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

describe('non-prop call-site attributes are opaque', () => {
  it('1. keeps a CSS custom property (it renders a <svelte-css-wrapper> element)', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Bare from './Bare.svelte';\n</script>\n` + `<Bare --accent="red" />\n`,
      // Declares no props at all: every attribute is "undeclared", the exact shape
      // in which the reverse pass used to empty the tag.
      '/Bare.svelte': `<p>bare</p>\n`,
    };
    const out = await shakeSound(files); // the HTML compare is the real assertion
    expect(out['/App.svelte']).toContain('--accent="red"');
  });

  it('2. keeps an unknown-namespace attribute, and still shakes the child', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n</script>\n` +
        `<Child label="hi" my:directive />\n`,
      '/Child.svelte': `<script>\n  let { label } = $props();\n</script>\n<p>{label}</p>\n`,
    };
    const out = await shakeSound(files);
    expect(out['/App.svelte']).toContain('my:directive');
    expect(out['/App.svelte']).not.toContain('label="hi"'); // the real prop still folds away
    // The marker must NOT cost the component its shake — that is the whole point
    // of fixing this instead of telling users to mark the child `external`.
    expect(out['/Child.svelte']).not.toMatch(/\$props\(\)/);
  });

  it('3. still removes a genuinely undeclared plain prop at the same site', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n  let { heavy } = $props();\n</script>\n` +
        `<Child icon={heavy} my:directive --accent="red" />\n`,
      '/Child.svelte': `<p>child</p>\n`,
    };
    const out = await shakeSound(files);
    expect(out['/App.svelte']).not.toContain('icon={heavy}');
    expect(out['/App.svelte']).toContain('<Child my:directive --accent="red" />');
  });

  it('4. leaves the tag tidy next to a `bind:` (no double space)', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n  let used = $state('x');\n</script>\n` +
        `<Child bind:used icon={used} my:directive />\n`,
      '/Child.svelte': `<script>\n  let { used = $bindable('a') } = $props();\n</script>\n<p>{used}</p>\n`,
    };
    const out = await shakeSound(files);
    expect(out['/App.svelte']).toContain('<Child bind:used my:directive />');
  });

  it('5. keeps a `$props()` entry whose key is a string literal when the rest folds away', async () => {
    const files = {
      '/App.svelte': `<script>\n  import Child from './Child.svelte';\n</script>\n<Child />\n`,
      // `y` folds to its default and drops; `'my:directive'` is invisible to the
      // engine's identifier-keyed prop model, so dropping the WHOLE declaration
      // would leave `marker` an undefined global — output that still COMPILES,
      // which is why the SSR compare, not `assertCompiles`, is what catches it.
      '/Child.svelte':
        `<script>\n  let { 'my:directive': marker, y = 1 } = $props();\n</script>\n` +
        `<p>{y}{marker}</p>\n`,
    };
    const out = await shakeSound(files);
    expect(out['/Child.svelte']).toContain("let { 'my:directive': marker } = $props();");
    expect(out['/Child.svelte']).toContain('{1}'); // `y` still folded — a guard, not a bail
  });
});
