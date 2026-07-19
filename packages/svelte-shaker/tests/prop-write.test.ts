import { afterAll, describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze';
import { svelteShaker, shakeWithRevertCascade } from '../src/index';
import { transformAll } from '../src/transform';
import { assertCompiles, cleanTmp, renderHtml } from './diff';

afterAll(() => cleanTmp());

// ----------------------------------------------------------------------
// Soundness: a prop that the component itself WRITES TO (reassigns, `++`s,
// destructure-assigns, or two-way `bind:`s) is not a constant even when every
// call site passes the same literal — the write changes it at runtime.  Folding
// such a prop substitutes its literal into the write's left-hand side (`"a" = …`,
// `0++`) or a `bind:` target (`bind:value={"a"}`), producing invalid Svelte; the
// engine then reverts the child but the parent's call-site edit remained, so the
// child silently rendered its default.  The fix refuses to fold any written prop,
// exactly like the shadow/`{@debug}` guards.  Each probe asserts the child stays
// sound AND the call-site attribute survives (the prop was not folded away).
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

/**
 * Shake `files` from `/App.svelte`, assert `/Child.svelte` compiles and renders
 * identical HTML before/after for each combo, and return the shaken App + Child.
 */
async function shakeChild(
  files: Record<string, string>,
  combos: Array<Record<string, unknown>>,
): Promise<{ app: string; child: string }> {
  const { resolve, readFile } = memGraph(files);
  const original = readFile('/Child.svelte');
  const out = await svelteShaker('/App.svelte', resolve, readFile);
  const child = out['/Child.svelte']!;
  assertCompiles(child, 'Child.svelte');
  for (const props of combos) {
    const before = await renderHtml(original, props, 'Child.svelte');
    const after = await renderHtml(child, props, 'Child.svelte');
    expect(after, JSON.stringify(props)).toBe(before);
  }
  return { app: out['/App.svelte']!, child };
}

describe('soundness probes: props written inside the component are not folded', () => {
  it('reassignment: a prop reassigned in an instance function is not folded', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n</script>\n` + `<Child label="a" />\n`,
      '/Child.svelte':
        `<script>\n  let { label = 'z' } = $props();\n  function shout() { label = 'b'; }\n</script>\n` +
        `<button onclick={shout}>{label}</button>\n{#if label === 'b'}<p>changed!</p>{/if}\n`,
    };
    const { app, child } = await shakeChild(files, [{ label: 'a' }]);
    // The prop is a runtime value, not a constant: the attribute survives and the
    // reassignment target is left as the bare identifier.
    expect(app).toContain('label="a"');
    expect(child).toMatch(/let \{ label = 'z' \}/);
    expect(child).toContain('label = ');
  });

  it('bindable: a $bindable prop written internally is not folded', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n</script>\n` + `<Child value="a" />\n`,
      '/Child.svelte':
        `<script>\n  let { value = $bindable('z') } = $props();\n  function set() { value = 'b'; }\n</script>\n` +
        `<button onclick={set}>{value}</button>\n{#if value === 'b'}<p>changed!</p>{/if}\n`,
    };
    const { app } = await shakeChild(files, [{ value: 'a' }]);
    expect(app).toContain('value="a"');
  });

  it('update: a prop mutated with `++` is not folded', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n</script>\n` + `<Child count={0} />\n`,
      '/Child.svelte':
        `<script>\n  let { count = 0 } = $props();\n  function inc() { count++; }\n</script>\n` +
        `<button onclick={inc}>{count}</button>\n{#if count === 5}<p>five</p>{/if}\n`,
    };
    const { app } = await shakeChild(files, [{ count: 0 }]);
    expect(app).toContain('count={0}');
  });

  it('destructuring assignment: a prop written via `({ p } = obj)` is not folded', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n</script>\n` + `<Child label="a" />\n`,
      '/Child.svelte':
        `<script>\n  let { label = 'z' } = $props();\n  function f(obj) { ({ label } = obj); }\n</script>\n` +
        `<button onclick={() => f({ label: 'b' })}>{label}</button>\n{#if label === 'b'}<p>changed!</p>{/if}\n`,
    };
    const { app } = await shakeChild(files, [{ label: 'a' }]);
    expect(app).toContain('label="a"');
  });

  it('bind: a prop two-way-bound in the template is not folded', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n</script>\n` + `<Child label="a" />\n`,
      '/Child.svelte':
        `<script>\n  let { label = 'z' } = $props();\n</script>\n` +
        `<input bind:value={label} />\n{#if label === 'b'}<p>changed!</p>{/if}\n`,
    };
    const { app, child } = await shakeChild(files, [{ label: 'a' }]);
    expect(app).toContain('label="a"');
    expect(child).toContain('bind:value={label}');
  });

  it('no over-block: a prop NOT written still folds when a sibling local is written', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n</script>\n` + `<Child label="a" />\n`,
      '/Child.svelte':
        `<script>\n  let { label = 'z' } = $props();\n  let other = 'x';\n  function f() { other = 'b'; }\n</script>\n` +
        `{#if label === 'a'}<p>hit</p>{/if}\n<span>{other}</span>\n`,
    };
    const { resolve, readFile } = memGraph(files);
    const out = await svelteShaker('/App.svelte', resolve, readFile);
    const child = out['/Child.svelte']!;
    assertCompiles(child, 'Child.svelte');
    // `label` is a genuine constant here: it folds, gets dropped from the
    // signature, and its attribute is removed from the call site.
    expect(out['/App.svelte']).not.toContain('label="a"');
    expect(child).not.toMatch(/let \{ label/);
    expect(child).toContain('<p>hit</p>');
    const before = await renderHtml(readFile('/Child.svelte'), { label: 'a' }, 'Child.svelte');
    const after = await renderHtml(child, { label: 'a' }, 'Child.svelte');
    expect(after).toBe(before);
  });
});

// ----------------------------------------------------------------------
// The last line of defense: if a transform ever emits source that fails to
// re-parse, reverting only the offending child is unsound — the parent's
// call-site edits for that child were already made against the (now discarded)
// folded child, so the child would render its default with no attribute to
// restore it.  The cascade instead force-bails every unparseable component and
// re-runs the whole transform, so the parent's edits are recomputed against a
// bailed (attribute-preserving) child.  We drive it directly with a transform
// that injects an unparseable child, since the fix above removes the only known
// natural trigger.
// ----------------------------------------------------------------------

describe('revert cascade: an unparseable child undoes its parent call-site edits', () => {
  const files = {
    '/App.svelte':
      `<script>\n  import Child from './Child.svelte';\n</script>\n` + `<Child label="a" />\n`,
    // `label` is a plain constant here (no write), so it folds normally: the child
    // drops it and the App call site loses `label="a"`.
    '/Child.svelte':
      `<script>\n  let { label = 'z' } = $props();\n</script>\n` +
      `{#if label === 'b'}<p>changed!</p>{/if}\n<p>{label}</p>\n`,
  };

  it('force-bails the child and restores the call-site attribute', async () => {
    const { resolve, readFile } = memGraph(files);
    const { models, plans } = await analyze('/App.svelte', resolve, readFile);
    let pass = 0;
    const out = shakeWithRevertCascade(models, plans, (p) => {
      const result = transformAll(models, p);
      // Simulate a transform bug that only affects the first, unbailed pass.
      if (pass++ === 0) result['/Child.svelte'] = '<script>\n  let x = ;\n</script>\n';
      return result;
    });
    // The child reverts to its original, and the parent's dropped attribute comes back.
    expect(out['/Child.svelte']).toBe(readFile('/Child.svelte'));
    expect(out['/App.svelte']).toContain('label="a"');
  });

  it('falls back to a whole-program no-op when a child never re-parses', async () => {
    const { resolve, readFile } = memGraph(files);
    const { models, plans } = await analyze('/App.svelte', resolve, readFile);
    const out = shakeWithRevertCascade(models, plans, (p) => {
      const result = transformAll(models, p);
      result['/Child.svelte'] = '<script>\n  let x = ;\n</script>\n'; // never parses, on every pass
      return result;
    });
    // Cap reached: every file is its untouched original (always sound).
    expect(out['/Child.svelte']).toBe(readFile('/Child.svelte'));
    expect(out['/App.svelte']).toBe(readFile('/App.svelte'));
  });
});
