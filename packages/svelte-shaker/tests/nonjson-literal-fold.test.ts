import { afterAll, describe, expect, it } from 'vitest';
import { svelteShaker, type ReadFile, type Resolve } from '../src/index';
import { tryLoadRsvelteParser } from '../src/rsvelte-parse';
import { assertCompiles, cleanTmp, renderGraphHtml } from './diff';

afterAll(() => cleanTmp());

// ----------------------------------------------------------------------
// Regression: a folded prop's value was turned back into source
// with a bare `JSON.stringify`, which is not total over the values that reach
// it. A `BigInt` THREW, aborting the whole-program shake (one `1n` anywhere
// silently reduced the entire app to a no-op for hosts that fall back on
// error), while a `RegExp` (`-> "{}"`), `Infinity`/`NaN` (`-> "null"`) and
// `-0` (`-> "0"`) did not throw at all: they folded to a DIFFERENT value than
// the one proven, which is the worse failure.
//
// The fix works on both layers: values outside the `Literal` union never enter
// (`evaluate`), and every value inside it has a faithful source form
// (`literalSource`).
// ----------------------------------------------------------------------

const rsvelte = tryLoadRsvelteParser();

/** Minimal in-memory module graph (POSIX-style absolute ids). */
function memGraph(files: Record<string, string>): { resolve: Resolve; readFile: ReadFile } {
  const resolve: Resolve = (source, importer) => {
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
  const readFile: ReadFile = (id) => {
    const code = files[id];
    if (code === undefined) throw new Error(`no such file: ${id}`);
    return code;
  };
  return { resolve, readFile };
}

/** Shake from `/App.svelte` and return the residual for every file. */
async function shake(files: Record<string, string>): Promise<Record<string, string>> {
  const { resolve, readFile } = memGraph(files);
  return await svelteShaker('/App.svelte', resolve, readFile);
}

/** The graph's rendered HTML, keyed by `./Name.svelte` as `renderGraphHtml` wants. */
async function render(files: Record<string, string>): Promise<string> {
  const rel = (id: string) => `.${id}`;
  const [entry, ...rest] = Object.keys(files);
  const deps = Object.fromEntries(rest.map((id) => [rel(id), files[id]!]));
  return await renderGraphHtml({ specifier: rel(entry!), source: files[entry!]! }, deps, {});
}

/** Shake, assert the residual still compiles, and assert it renders IDENTICALLY
 * to the original graph — the differential-SSR oracle, in-memory. */
async function shakeAndCompare(files: Record<string, string>): Promise<Record<string, string>> {
  const before = await render(files);
  const shaken = await shake(files);
  for (const [id, code] of Object.entries(shaken)) assertCompiles(code, id);
  expect(await render({ ...files, ...shaken })).toBe(before);
  return shaken;
}

describe('values `JSON.stringify` cannot faithfully represent', () => {
  it('a BigInt prop does not abort the shake, and is left unfolded', async () => {
    // The reporter's exact repro.
    const files = {
      '/App.svelte': `<script>\n  import Child from './Child.svelte';\n  const bigintVal = 1n;\n</script>\n<Child {bigintVal} />`,
      '/Child.svelte': `<script>\n  let { bigintVal } = $props();\n</script>\n<p>{bigintVal}</p>`,
    };
    const shaken = await shakeAndCompare(files);
    // Unprovable, so the prop stays: a missed optimization, never a wrong value.
    expect(shaken['/Child.svelte']).toContain('$props()');
    expect(shaken['/Child.svelte']).toContain('{bigintVal}');
  });

  it.skipIf(!rsvelte)('the BigInt repro also survives the rsvelte parser', async () => {
    const files = {
      '/App.svelte': `<script>\n  import Child from './Child.svelte';\n  const bigintVal = 9007199254740993n;\n</script>\n<Child {bigintVal} />`,
      '/Child.svelte': `<script>\n  let { bigintVal } = $props();\n</script>\n<p>{bigintVal}</p>`,
    };
    const { resolve, readFile } = memGraph(files);
    const shaken = await svelteShaker('/App.svelte', resolve, readFile, rsvelte!);
    expect(shaken['/Child.svelte']).toContain('{bigintVal}');
  });

  it('a RegExp prop is left unfolded instead of folding to `{}`', async () => {
    const files = {
      '/App.svelte': `<script>\n  import Child from './Child.svelte';\n</script>\n<Child re={/ab+c/g} />`,
      '/Child.svelte': `<script>\n  let { re } = $props();\n</script>\n<p>{re}</p>`,
    };
    const shaken = await shakeAndCompare(files);
    expect(shaken['/Child.svelte']).toContain('{re}');
    expect(shaken['/Child.svelte']).not.toContain('{}');
  });

  it('one unfoldable value does not cost the REST of the program its shake', async () => {
    // The blast radius that actually hurt: before the fix the `BigInt` threw out
    // of the whole-program transform, so `Sibling` — nothing to do with it —
    // silently kept its dead branch too.
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n  import Sibling from './Sibling.svelte';\n  const bigintVal = 1n;\n</script>\n` +
        `<Child {bigintVal} />\n<Sibling variant="plain" />`,
      '/Child.svelte': `<script>\n  let { bigintVal } = $props();\n</script>\n<p>{bigintVal}</p>`,
      '/Sibling.svelte':
        `<script>\n  let { variant = 'plain' } = $props();\n</script>\n` +
        `{#if variant === 'fancy'}<span>fancy</span>{/if}\n<p>base</p>`,
    };
    const shaken = await shakeAndCompare(files);
    expect(shaken['/Sibling.svelte']).not.toContain('fancy');
    expect(shaken['/Sibling.svelte']).not.toContain('$props()');
  });

  it('folds `Infinity` / `NaN` faithfully instead of to `null`', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n</script>\n` +
        `<Child inf={1 / 0} negInf={-1 / 0} nan={0 / 0} />`,
      '/Child.svelte':
        `<script>\n  let { inf, negInf, nan } = $props();\n</script>\n` +
        `<p>{inf} {negInf} {nan}</p>`,
    };
    const shaken = await shakeAndCompare(files);
    const child = shaken['/Child.svelte']!;
    expect(child).toContain('(1/0)');
    expect(child).toContain('(-1/0)');
    expect(child).toContain('(0/0)');
    expect(child).not.toContain('null');
  });

  it('leaves a `-0` prop alone rather than folding it to `0`', async () => {
    // `{n}` alone cannot catch this — the DOM stringifies -0 as "0" either way.
    // `1 / n` is the observable that flips: -Infinity with the real prop, and
    // Infinity once folded, because the SVELTE compiler then constant-folds the
    // substituted expression and loses the sign of zero. So we do not fold it.
    const files = {
      '/App.svelte': `<script>\n  import Child from './Child.svelte';\n</script>\n<Child n={-0} />`,
      '/Child.svelte': `<script>\n  let { n } = $props();\n</script>\n<p>{1 / n}</p>`,
    };
    const shaken = await shakeAndCompare(files);
    expect(shaken['/Child.svelte']).toContain('$props()');
    expect(shaken['/App.svelte']).toContain('n={-0}');
  });

  it('a numeric literal too large for JSON transport stays unfolded', async () => {
    // `1e999` IS `Infinity`, but an AST that crossed a JSON boundary (rsvelte)
    // reports it as `value: null` — indistinguishable from a real `null` except
    // by `raw`. Unprovable beats guessing wrong, so it is simply not folded.
    const files = {
      '/App.svelte': `<script>\n  import Child from './Child.svelte';\n</script>\n<Child n={1e999} />`,
      '/Child.svelte': `<script>\n  let { n } = $props();\n</script>\n<p>{n}</p>`,
    };
    const shaken = await shakeAndCompare(files);
    expect(shaken['/Child.svelte']).not.toContain('null');
  });

  it('still folds a genuine `null`', async () => {
    const files = {
      '/App.svelte': `<script>\n  import Child from './Child.svelte';\n</script>\n<Child n={null} />`,
      '/Child.svelte': `<script>\n  let { n } = $props();\n</script>\n<p>{n === null ? 'nil' : 'other'}</p>`,
    };
    const shaken = await shakeAndCompare(files);
    expect(shaken['/Child.svelte']).not.toContain('$props()');
  });
});
