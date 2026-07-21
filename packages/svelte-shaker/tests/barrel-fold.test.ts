import { describe, expect, it, afterAll } from 'vitest';
import { svelteShaker, analyze } from '../src/index';
import { renderHtml, assertCompiles, cleanTmp } from './diff';

// ----------------------------------------------------------------------
// A component imported through a NAMED barrel re-export (the design-system /
// UI-library shape: `import { Button } from '@ui'`, where `@ui` is a `.js`/`.ts`
// barrel re-exporting `./Button.svelte`'s default) must be shaken just like a
// direct `import Button from './Button.svelte'`.
//
// The local name a named import binds (`Lib`) pins the child component exactly,
// so a `<Lib .../>` call site is just as attributable to the child's value set
// as a default-svelte site is.  Folding it is therefore sound, and refusing to
// (the old BARREL bail) leaves every library component untouched — which makes
// the shaker a no-op on the overwhelmingly common "app consumes a component
// library via a barrel" setup.
//
// This is the failing test that defines the gap (repo rule: a bug gets a failing
// test first).  Soundness is defended by the SSR oracle: the shaken child must
// render byte-identical HTML for the values the app actually passes.
// ----------------------------------------------------------------------

/** Minimal in-memory module graph (POSIX-style absolute ids); mirrors batch.test.ts. */
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

/**
 * App renders the library component `<Lib msg="hi" />` and never passes
 * `variant`, so `variant` is always its default `'primary'` and the
 * `variant === 'secondary'` arm is dead.  `Lib` is reached through a named
 * re-export in `./ui.js`.
 */
const FILES: Record<string, string> = {
  '/App.svelte': `<script lang="ts">
  import { Lib } from './ui.js';
</script>
<Lib msg="hi" />`,
  '/ui.js': `export { default as Lib } from './Lib.svelte';`,
  '/Lib.svelte': `<script lang="ts">
  let { msg, variant = 'primary' }: { msg: string; variant?: 'primary' | 'secondary' } = $props();
</script>
<p>{msg}</p>
{#if variant === 'secondary'}<span class="secondary">SECONDARY_ARM</span>{/if}`,
};

afterAll(cleanTmp);

describe('named-barrel imported component is shaken (design-system shape)', () => {
  it('folds a never-passed prop reached through a named barrel re-export', async () => {
    const { resolve, readFile } = memGraph(FILES);
    const out = await svelteShaker('/App.svelte', resolve, readFile);
    const lib = out['/Lib.svelte']!;

    // The dead `variant === 'secondary'` arm is removed and `variant` is dropped
    // from the signature (it only ever takes its 'primary' default).
    expect(lib).not.toContain('SECONDARY_ARM');
    expect(lib).not.toContain('variant');
    // The child was genuinely shaken, not left untouched: the original arm text is
    // gone and the result still compiles as valid Svelte.
    expect(lib).not.toBe(FILES['/Lib.svelte']);
    assertCompiles(lib, '/Lib.svelte');
  });

  it('is sound: the shaken child renders identical HTML for the value the app passes', async () => {
    const { resolve, readFile } = memGraph(FILES);
    const out = await svelteShaker('/App.svelte', resolve, readFile);

    // The app only ever renders `<Lib msg="hi" />` (variant defaulted).
    const props = { msg: 'hi' };
    const before = await renderHtml(FILES['/Lib.svelte']!, props, '/Lib.svelte');
    const after = await renderHtml(out['/Lib.svelte']!, props, '/Lib.svelte');
    expect(after).toBe(before);
  });
});

// ----------------------------------------------------------------------
// A component rendered through a NAMESPACE member tag (`import * as ui from '@ui';
// <ui.Lib .../>`) is resolved per member through the same barrel logic a named
// import uses, so it is attributed and folds too.  And when the namespace OBJECT
// itself is read as a value, the whole namespace could be rendered dynamically,
// so every member it exposes must bail (soundness).
// ----------------------------------------------------------------------

describe('namespace member render (`<ns.Lib/>`) is attributed', () => {
  const NS_FILES: Record<string, string> = {
    '/App.svelte': `<script lang="ts">
  import * as ui from './ui.js';
</script>
<ui.Lib msg="hi" />`,
    '/ui.js': `export { default as Lib } from './Lib.svelte';`,
    '/Lib.svelte': `<script lang="ts">
  let { msg, variant = 'primary' }: { msg: string; variant?: 'primary' | 'secondary' } = $props();
</script>
<p>{msg}</p>
{#if variant === 'secondary'}<span>SECONDARY_ARM</span>{/if}`,
  };

  it('folds a never-passed prop reached through a `<ns.Lib/>` member tag', async () => {
    const { resolve, readFile } = memGraph(NS_FILES);
    const out = await svelteShaker('/App.svelte', resolve, readFile);
    const lib = out['/Lib.svelte']!;
    expect(lib).not.toContain('SECONDARY_ARM');
    expect(lib).not.toContain('variant');
    assertCompiles(lib, '/Lib.svelte');

    const before = await renderHtml(NS_FILES['/Lib.svelte']!, { msg: 'hi' }, '/Lib.svelte');
    const after = await renderHtml(lib, { msg: 'hi' }, '/Lib.svelte');
    expect(after).toBe(before);
  });

  it('follows a TYPESCRIPT barrel (the design-system `index.ts` shape)', async () => {
    // A real design-system `index.ts` mixes `export type { … }` and type-only
    // specifiers with the value re-exports.  A plain-JS parse throws on those, so
    // the whole library would go unfollowed; the barrel must parse as TS.
    const files: Record<string, string> = {
      '/App.svelte': `<script lang="ts">
  import { Lib } from './ui.ts';
</script>
<Lib msg="hi" />`,
      '/ui.ts': `export type { Whatever } from './types.ts';
export { type Other, foo } from './util.ts';
export { default as Lib } from './Lib.svelte';`,
      '/Lib.svelte': NS_FILES['/Lib.svelte']!,
    };
    const { resolve, readFile } = memGraph(files);
    const out = await svelteShaker('/App.svelte', resolve, readFile);
    expect(out['/Lib.svelte']!).not.toContain('SECONDARY_ARM');
    expect(out['/Lib.svelte']!).not.toContain('variant');
  });

  it('follows a barrel whose text mentions `</script>` (issue #146)', async () => {
    // The same `<script module>` wrapper the escape scan uses drives
    // barrel-following, so a barrel that merely mentions `</script>` in a comment
    // must still parse and be chased — otherwise the library goes unfollowed.
    const files: Record<string, string> = {
      '/App.svelte': `<script lang="ts">
  import { Lib } from './ui.ts';
</script>
<Lib msg="hi" />`,
      '/ui.ts': `// re-exports the design system; see the </script> note in the docs
export { default as Lib } from './Lib.svelte';`,
      '/Lib.svelte': NS_FILES['/Lib.svelte']!,
    };
    const { resolve, readFile } = memGraph(files);
    const out = await svelteShaker('/App.svelte', resolve, readFile);
    expect(out['/Lib.svelte']!).not.toContain('SECONDARY_ARM');
    expect(out['/Lib.svelte']!).not.toContain('variant');
  });

  it('bails when the namespace object itself escapes as a value', async () => {
    const files: Record<string, string> = {
      '/App.svelte': `<script lang="ts">
  import * as ui from './ui.js';
  const all = ui;
  void all;
</script>
<ui.Lib msg="hi" />`,
      '/ui.js': NS_FILES['/ui.js']!,
      '/Lib.svelte': NS_FILES['/Lib.svelte']!,
    };
    const { resolve, readFile } = memGraph(files);
    const { plans } = await analyze('/App.svelte', resolve, readFile);
    // `const all = ui` leaks the namespace, so `ui.Lib` could be rendered
    // dynamically — the member must bail rather than fold on the visible site.
    expect(plans.get('/Lib.svelte')!.bail).toBe(true);
    const out = await svelteShaker('/App.svelte', resolve, readFile);
    expect(out['/Lib.svelte']!).toContain('SECONDARY_ARM');
  });
});
