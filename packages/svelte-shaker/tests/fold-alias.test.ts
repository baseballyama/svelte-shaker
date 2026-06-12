import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { svelteShaker } from '../src/index';
import { fsResolve } from '../src/scan';
import { analyze } from '../src/analyze';
import { assertCompiles, cleanTmp, renderHtml } from './diff';

afterAll(() => cleanTmp());

const FIXTURES = resolve(__dirname, 'fixtures');
const readFile = (id: string) => readFileSync(id, 'utf-8');

/** Minimal in-memory module graph for the engine (POSIX-style absolute ids). */
function memGraph(files: Record<string, string>): {
  resolve: (source: string, importer: string) => string | null;
  readFile: (id: string) => string;
} {
  const res = (source: string, importer: string): string | null => {
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
  const read = (id: string): string => {
    const code = files[id];
    if (code === undefined) throw new Error(`no such file: ${id}`);
    return code;
  };
  return { resolve: res, readFile: read };
}

// ----------------------------------------------------------------------
// Issue #37: aliased `$props()` destructuring (`prop: alias = default`).
//
// The engine folds a never-passed prop to its default.  For an ALIASED entry the
// fold must (a) substitute the LOCAL alias, not the external prop name, and (b)
// leave a same-named IMPORT alone — it is a different entity.  Getting either
// wrong dangles a reference or corrupts the import.  A nested-pattern entry
// (`prop: { x }`) has no single local identifier, so it must never fold.
// ----------------------------------------------------------------------

describe('issue #37: aliased prop folding', () => {
  it('fold-alias fixture: alias refs fold, the same-named import is untouched', async () => {
    const dir = join(FIXTURES, 'fold-alias');
    const out = await svelteShaker(join(dir, 'input', 'App.svelte'), fsResolve, readFile);
    const shaken = out[join(dir, 'input', 'Sub.svelte')]!;

    // (1) The local alias references were substituted with the proven literal.
    expect(shaken).toContain('modeStorageKey.current = "mode-watcher-mode";');
    expect(shaken).toContain('themeStorageKey.current = "mode-watcher-theme";');
    expect(shaken).toContain('<p>mode key: {"mode-watcher-mode"}</p>');
    // No dangling alias identifier survives.
    expect(shaken).not.toContain('modeStorageKeyProp');
    expect(shaken).not.toContain('themeStorageKeyProp');

    // (2) The same-named import was NOT folded/corrupted — its statement and its
    // member-access uses are byte-identical to the input.
    expect(shaken).toContain("import { modeStorageKey, themeStorageKey } from './keys.js';");
    expect(shaken).not.toContain('"mode-watcher-mode".current');

    // The dead `{#if}` arm is gone and the folded props left the signature.
    expect(shaken).not.toContain('no head script');
    expect(shaken).not.toContain('$props()');
  });

  it('fold-alias fixture: shaken Sub renders identical HTML (no props passed)', async () => {
    const dir = join(FIXTURES, 'fold-alias');
    const original = readFile(join(dir, 'input', 'Sub.svelte'));
    const keys = readFile(join(dir, 'input', 'keys.js'));
    const out = await svelteShaker(join(dir, 'input', 'App.svelte'), fsResolve, readFile);
    const shaken = out[join(dir, 'input', 'Sub.svelte')]!;

    // App renders `<Sub />` with no attributes, so the only occurring shape is
    // "all defaults".  The same-named import is supplied as a sibling so the
    // static `import './keys.js'` resolves at render time.
    const siblings = { 'keys.js': keys };
    const before = await renderHtml(original, {}, 'Sub.svelte', siblings);
    const after = await renderHtml(shaken, {}, 'Sub.svelte', siblings);
    expect(after).toBe(before);
    expect(before).toContain('mode key: mode-watcher-mode');
  });

  it('a prop bound to a nested pattern (`prop: { x }`) is left untouched', async () => {
    // `<Sub />` never passes `data`, so the OLD engine folded it and deleted the
    // `{ x }` binding.  A nested pattern has no single local identifier, so the
    // prop must now be unfoldable: no plan entry, no signature edit.  (Svelte
    // itself rejects a nested `$props()` pattern, so this is a DEFENSIVE case —
    // the engine parses it but must never make such input worse than untouched.)
    const files = {
      '/App.svelte': `<script>\n  import Sub from './Sub.svelte';\n</script>\n<Sub />\n`,
      '/Sub.svelte':
        `<script>\n  let { data: { x } = { x: 1 } } = $props();\n</script>\n` + `<p>{x}</p>\n`,
    };
    const { resolve: res, readFile: read } = memGraph(files);

    const { plans } = await analyze('/App.svelte', res, read);
    const plan = plans.get('/Sub.svelte')!;
    expect(plan.bail).toBe(false);
    expect(plan.constFold.has('data')).toBe(false);
    expect(plan.narrow.has('data')).toBe(false);

    const out = await svelteShaker('/App.svelte', res, read);
    // Untouched: the nested destructure and its `x` reference survive verbatim.
    expect(out['/Sub.svelte']).toBe(files['/Sub.svelte']);
  });

  it('an aliased prop whose LOCAL name is a snippet param is NOT folded', async () => {
    // `label={'x'}` would fold, but the alias `row` is rebound by the snippet
    // param `row` — a different entity.  The shadow guard must test the LOCAL
    // name, or folding `row` corrupts the snippet body / param.
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n</script>\n` + `<Child label={'x'} />\n`,
      '/Child.svelte':
        `<script>\n  let { label: row = 'y' } = $props();\n</script>\n` +
        `{#snippet item(row)}<span>{row}</span>{/snippet}\n` +
        `<p>{row}</p>\n{@render item('z')}\n`,
    };
    const { resolve: res, readFile: read } = memGraph(files);

    const { plans } = await analyze('/App.svelte', res, read);
    const plan = plans.get('/Child.svelte')!;
    expect(plan.constFold.has('label')).toBe(false); // local `row` is shadowed

    const out = await svelteShaker('/App.svelte', res, read);
    expect(out['/Child.svelte']).toBe(files['/Child.svelte']); // untouched
    assertCompiles(out['/Child.svelte']!, 'Child.svelte');
  });
});
