import { afterAll, describe, expect, it } from 'vitest';
import { svelteShaker } from '../src/index';
import { assertCompiles, cleanTmp, renderHtml } from './diff';

// ----------------------------------------------------------------------
// Transform robustness on real-world component shapes that the golden fixtures
// did not cover, each of which made the shaker emit invalid source (or crash with
// a MagicString "Cannot split a chunk that has already been edited") until fixed.
// The SSR oracle (`renderHtml`) plus `assertCompiles` are the soundness guards.
// ----------------------------------------------------------------------

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

afterAll(cleanTmp);

describe('transform robustness', () => {
  it('drops several CONSECUTIVE trailing props (incl. a trailing comma) cleanly', async () => {
    // The app passes only `a`, so `b`, `c`, `d` fold to their defaults and are
    // dropped.  Removing the trailing run must not leave a dangling `,` — `d` even
    // has a trailing comma, which has to go too.
    const files: Record<string, string> = {
      '/App.svelte': `<script lang="ts">
  import Child from './Child.svelte';
</script>
<Child a={1} />`,
      '/Child.svelte': `<script lang="ts">
  let { a, b = 1, c = 2, d = 3, }: { a: number; b?: number; c?: number; d?: number } = $props();
</script>
<p>{a}{b}{c}{d}</p>`,
    };
    const { resolve, readFile } = memGraph(files);
    const out = await svelteShaker('/App.svelte', resolve, readFile);
    const child = out['/Child.svelte']!;
    expect(child).not.toMatch(/\bb\b.*=.*1/); // signature props gone
    expect(child).not.toContain(', ,');
    expect(child).not.toContain(',\n  }');
    assertCompiles(child, '/Child.svelte');
    expect(await renderHtml(child, { a: 1 }, '/Child.svelte')).toBe(
      await renderHtml(files['/Child.svelte']!, { a: 1 }, '/Child.svelte'),
    );
  });

  it('does not overlap-edit when a folded-away branch contains a child call site', async () => {
    // `mode` is always 'a', so the `{#if mode === 'b'}` arm (which renders
    // `<Inner .../>`) is dead and removed.  That call site is the ONLY one for
    // `Inner`, so `Inner.gone` folds and is dropped — but its attribute removal
    // must NOT fire inside the already-removed arm (the crash this guards).
    const files: Record<string, string> = {
      '/App.svelte': `<script lang="ts">
  import Child from './Child.svelte';
</script>
<Child mode="a" />`,
      '/Child.svelte': `<script lang="ts">
  import Inner from './Inner.svelte';
  let { mode = 'a' }: { mode?: 'a' | 'b' } = $props();
</script>
{#if mode === 'b'}<Inner gone={true} />{/if}
<p>base</p>`,
      '/Inner.svelte': `<script lang="ts">
  let { gone = false }: { gone?: boolean } = $props();
</script>
{#if gone}<span>X</span>{/if}<i>inner</i>`,
    };
    const { resolve, readFile } = memGraph(files);
    // The bug this guards was a hard crash in `svelteShaker` itself
    // (overlapping MagicString edits), so simply completing + compiling is the
    // core of the regression.
    const out = await svelteShaker('/App.svelte', resolve, readFile);
    assertCompiles(out['/Child.svelte']!, '/Child.svelte');
    assertCompiles(out['/Inner.svelte']!, '/Inner.svelte');
    // The dead arm and its `<Inner/>` instance are gone; the base content stays.
    const child = out['/Child.svelte']!;
    expect(child).not.toContain('<Inner');
    expect(child).toContain('base');
  });

  it('does NOT fold a same-named prop into a TS interface/type member KEY', async () => {
    // `width`/`height` are never passed, so they fold to 36/20 and the body refs
    // become `{36}`/`{20}`. But the `interface Props { width?: number }` member KEY
    // is a TYPE-position name, not a value read — folding it would corrupt the type
    // to `36?: number`. (Pre-existing bug; the type is compile-erased so it was
    // byte-wrong but not a runtime fault.)
    const files: Record<string, string> = {
      '/App.svelte': `<script lang="ts">
  import Child from './Child.svelte';
</script>
<Child />`,
      '/Child.svelte': `<script lang="ts">
  interface Props {
    variant: string;
    width?: number;
    height?: number;
  }
  const { variant = 'a', width = 36, height = 20 }: Props = $props();
</script>
<p>{variant}{width}{height}</p>`,
    };
    const { resolve, readFile } = memGraph(files);
    const out = await svelteShaker('/App.svelte', resolve, readFile);
    const child = out['/Child.svelte']!;
    // Body reads fold; interface member keys are preserved (NOT rewritten to literals).
    expect(child).toContain('{36}');
    expect(child).toContain('width?: number');
    expect(child).toContain('height?: number');
    expect(child).not.toContain('36?: number');
    expect(child).not.toContain('20?: number');
    expect(child).not.toContain('"a": string'); // `variant` key must stay `variant`
    assertCompiles(child, '/Child.svelte');
    expect(await renderHtml(child, {}, '/Child.svelte')).toBe(
      await renderHtml(
        files['/Child.svelte']!,
        { variant: 'a', width: 36, height: 20 },
        '/Child.svelte',
      ),
    );
  });

  it('expands an object SHORTHAND when substituting a folded prop', async () => {
    // `label` folds to "hi"; used as `{ label }` shorthand it must expand to
    // `{ label: "hi" }`, not collapse to `{ "hi" }` (invalid).
    const files: Record<string, string> = {
      '/App.svelte': `<script lang="ts">
  import Child from './Child.svelte';
</script>
<Child label="hi" />`,
      '/Child.svelte': `<script lang="ts">
  let { label = 'x' }: { label?: string } = $props();
  const cfg = { label };
</script>
<p>{cfg.label}</p>`,
    };
    const { resolve, readFile } = memGraph(files);
    const out = await svelteShaker('/App.svelte', resolve, readFile);
    const child = out['/Child.svelte']!;
    expect(child).toContain('label: "hi"');
    assertCompiles(child, '/Child.svelte');
    expect(await renderHtml(child, {}, '/Child.svelte')).toBe(
      await renderHtml(files['/Child.svelte']!, { label: 'hi' }, '/Child.svelte'),
    );
  });
});
