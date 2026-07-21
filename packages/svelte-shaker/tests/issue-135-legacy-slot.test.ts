import { afterAll, describe, expect, it } from 'vitest';
import { svelteShaker } from '../src/index';
import { assertCompiles, cleanTmp, renderGraphHtml } from './diff';

afterAll(() => cleanTmp());

// ----------------------------------------------------------------------
// Regression: issue #135 — the reverse pass must not drop default-slot body
// content passed to a legacy `<slot>` component.
//
// A legacy-`<slot>` component has no `$props()` shape describing its inputs: the
// content it renders arrives as slotted children / `$$slots`, outside `$props()`.
// The reverse pass models a child's reachable inputs from `$props()`, so such a
// component looked like "reads no input" and the body supplying its slot was
// classified as unread and deleted — an unsound change to the rendered HTML.
//
// Every probe runs the real engine over an in-memory graph and asserts the whole
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
    deps[`.${id}`] = src; // `/Child.svelte` -> `./Child.svelte`
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

describe('issue #135: default slot content for legacy `<slot>` components', () => {
  it('keeps the default-slot body passed to a no-instance-script legacy `<slot>`', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Wrapper from './Wrapper.svelte';\n  import Child from './Child.svelte';\n</script>\n` +
        `<Wrapper let:val><Child text={val} /></Wrapper>\n`,
      '/Wrapper.svelte': `<slot val="inner" />\n`,
      '/Child.svelte': `<script>\n  let { text } = $props();\n</script>\n<span>{text}</span>\n`,
    };
    const out = await shakeSound(files);
    // The slot-carrying body must survive at the call site.
    expect(out['/App.svelte']!).toContain('<Child');
  });

  it('keeps the default-slot body when the legacy `<slot>` sits beside an instance script', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Wrapper from './Wrapper.svelte';\n  import Child from './Child.svelte';\n</script>\n` +
        `<Wrapper let:val><Child text={val} /></Wrapper>\n`,
      // A component can mix an instance script (with `$props()`) and a legacy
      // `<slot>`: `label` is a real prop, but the slotted content it renders is
      // still outside `$props()`, so its reachable inputs are not modelable.
      '/Wrapper.svelte':
        `<script>\n  let { label = 'hi' } = $props();\n</script>\n` +
        `<b>{label}</b><slot val="inner" />\n`,
      '/Child.svelte': `<script>\n  let { text } = $props();\n</script>\n<span>{text}</span>\n`,
    };
    const out = await shakeSound(files);
    expect(out['/App.svelte']!).toContain('<Child');
  });

  it('keeps the body when the component reads `$$slots` without a `<slot>` element', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Wrapper from './Wrapper.svelte';\n</script>\n` +
        `<Wrapper>hello</Wrapper>\n`,
      // `$$slots` is legal in runes mode (unlike `$$props`/`$$restProps`) and
      // observes slotted content without ever writing a `<slot>` element, so the
      // same reachable-input hole applies: the body must not be dropped.
      '/Wrapper.svelte': `{#if $$slots.default}<div class="has-content"></div>{/if}\n`,
    };
    const out = await shakeSound(files);
    expect(out['/App.svelte']!).toContain('hello');
  });
});
