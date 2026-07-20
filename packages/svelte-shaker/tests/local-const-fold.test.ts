import { afterAll, describe, expect, it } from 'vitest';
import { svelteShaker } from '../src/index';
import { analyze } from '../src/analyze';
import { assertCompiles, cleanTmp, renderGraphHtml } from './diff';

afterAll(() => cleanTmp());

// ----------------------------------------------------------------------
// Owner-local constant folding at call sites (docs §13.1).
//
// A call-site expression that references an OWNER-local binding provably equal to
// a primitive constant — `const x = 0`, an unmutated `let x = $state(0)` — is
// resolved against the owner's `scriptConstEnv` and feeds the child's value set,
// exactly as a call-site literal does.  This drives BOTH constant folding (a
// singleton set) and value-set narrowing (a set built from several sites).
//
// Every probe runs the real engine over an in-memory App -> … graph; positive
// cases additionally assert the whole program still server-renders identical HTML
// (the soundness oracle).  The negatives assert the binding is (soundly) NOT
// admitted, so nothing downstream folds.
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

async function analyzeFiles(files: Record<string, string>) {
  const { resolve, readFile } = memGraph(files);
  return analyze('/App.svelte', resolve, readFile);
}

describe('owner-local constant folding at call sites (docs §13.1)', () => {
  it('1. an unmutated `let x = $state(0)` folds -> child dead `{#if}` arm removed', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Toggle from './Toggle.svelte';\n  let count = $state(0);\n</script>\n` +
        `<Toggle {count} />\n`,
      '/Toggle.svelte':
        `<script>\n  let { count = 5 } = $props();\n</script>\n` +
        `{#if count > 0}<strong>on</strong>{/if}\n<p>{count}</p>\n`,
    };
    const { models, plans } = await analyzeFiles(files);
    expect([...models.get('/App.svelte')!.scriptConstEnv]).toEqual([['count', 0]]);
    expect(plans.get('/Toggle.svelte')!.constFold.get('count')).toBe(0);

    const out = await shakeSound(files);
    const toggle = out['/Toggle.svelte']!;
    expect(toggle).not.toContain('$props'); // count dropped from the signature
    expect(toggle).not.toContain('<strong>'); // `count > 0` folded false -> arm removed
    expect(toggle).toContain('{0}'); // the surviving reference was substituted
    expect(out['/App.svelte']!).toContain('<Toggle />'); // attribute removed
  });

  it('2. a `const` participates in value-set narrowing with another site literal', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Btn from './Btn.svelte';\n  const VARIANT = 'primary';\n</script>\n` +
        `<Btn variant={VARIANT} />\n<Btn variant="secondary" />\n`,
      '/Btn.svelte':
        `<script>\n  let { variant } = $props();\n</script>\n` +
        `{#if variant === 'danger'}<b>D</b>{:else}<i>{variant}</i>{/if}\n`,
    };
    const { plans } = await analyzeFiles(files);
    // The owner const joins the other site's literal into a 2-value set -> narrow.
    expect(plans.get('/Btn.svelte')!.narrow.get('variant')).toEqual(['primary', 'secondary']);

    const out = await shakeSound(files);
    const btn = out['/Btn.svelte']!;
    expect(btn).not.toContain('danger'); // 'danger' ∉ {primary,secondary} -> arm dead
    expect(btn).toContain('{variant}'); // still used (>=2 values) -> not substituted/dropped
  });

  it('3. sequential consts resolve in order (`const a = 1; const b = a + 1`)', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import N from './N.svelte';\n  const a = 1;\n  const b = a + 1;\n</script>\n` +
        `<N value={b} />\n`,
      '/N.svelte':
        `<script>\n  let { value } = $props();\n</script>\n` +
        `{#if value === 2}<b>two</b>{:else}<i>other</i>{/if}\n`,
    };
    const { models, plans } = await analyzeFiles(files);
    expect([...models.get('/App.svelte')!.scriptConstEnv]).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
    expect(plans.get('/N.svelte')!.constFold.get('value')).toBe(2);

    const out = await shakeSound(files);
    expect(out['/N.svelte']!).toContain('<b>two</b>');
    expect(out['/N.svelte']!).not.toContain('other');
  });

  it('extra: module-script const + bare `$state()` (undefined) fold; `$state.raw` unwraps', async () => {
    const files = {
      '/App.svelte':
        `<script module>\n  const M = 'mod';\n</script>\n` +
        `<script>\n  import C from './C.svelte';\n  let u = $state();\n  let r = $state.raw('raw');\n</script>\n` +
        `<C m={M} u={u} r={r} />\n`,
      '/C.svelte':
        `<script>\n  let { m, u, r } = $props();\n</script>\n` + `<span>{m}|{u}|{r}</span>\n`,
    };
    const { models, plans } = await analyzeFiles(files);
    const env = models.get('/App.svelte')!.scriptConstEnv;
    expect(env.get('M')).toBe('mod');
    expect(env.has('u')).toBe(true);
    expect(env.get('u')).toBe(undefined); // bare `$state()` -> undefined
    expect(env.get('r')).toBe('raw'); // `$state.raw(<arg>)` unwrapped
    const c = plans.get('/C.svelte')!.constFold;
    expect(c.get('m')).toBe('mod');
    expect(c.get('r')).toBe('raw');
    expect(c.has('u')).toBe(true);

    await shakeSound(files);
  });

  it('extra: an `export const` is NOT admitted (reachable outside the graph)', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import C from './C.svelte';\n  export const K = 'k';\n</script>\n` +
        `<C v={K} />\n`,
      '/C.svelte':
        `<script>\n  let { v } = $props();\n</script>\n` +
        `{#if v === 'k'}<b>k</b>{:else}<i>o</i>{/if}\n`,
    };
    const { models, plans } = await analyzeFiles(files);
    expect(models.get('/App.svelte')!.scriptConstEnv.has('K')).toBe(false);
    expect(plans.get('/C.svelte')!.constFold.has('v')).toBe(false);
    await shakeSound(files); // still sound (nothing folded)
  });

  it('4. NEGATIVE: a `$state` reassigned in a handler is not a constant', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import C from './C.svelte';\n  let count = $state(0);\n  function inc() { count++; }\n</script>\n` +
        `<C n={count} />\n<button onclick={inc}>+</button>\n`,
      '/C.svelte':
        `<script>\n  let { n } = $props();\n</script>\n` +
        `{#if n > 0}<b>pos</b>{:else}<i>zero</i>{/if}\n`,
    };
    const { models, plans } = await analyzeFiles(files);
    expect(models.get('/App.svelte')!.scriptConstEnv.has('count')).toBe(false); // written
    expect(plans.get('/C.svelte')!.constFold.has('n')).toBe(false);
    await shakeSound(files);
  });

  it('5. NEGATIVE: a name used as a `bind:` target is not a constant', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Field from './Field.svelte';\n  import C from './C.svelte';\n  let text = $state('x');\n</script>\n` +
        `<Field bind:value={text} />\n<C v={text} />\n`,
      '/Field.svelte':
        `<script>\n  let { value = $bindable('') } = $props();\n</script>\n` +
        `<input bind:value />\n`,
      '/C.svelte':
        `<script>\n  let { v } = $props();\n</script>\n` +
        `{#if v === 'x'}<b>x</b>{:else}<i>o</i>{/if}\n`,
    };
    const { models, plans } = await analyzeFiles(files);
    expect(models.get('/App.svelte')!.scriptConstEnv.has('text')).toBe(false); // bind: writes it
    expect(plans.get('/C.svelte')!.constFold.has('v')).toBe(false);
    await shakeSound(files);
  });

  it('6. NEGATIVE: a name shadowed by an `{#each}` binder is not admitted', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import C from './C.svelte';\n  const label = 'outer';\n  const size = 'lg';\n  const items = ['a', 'b'];\n</script>\n` +
        `{#each items as label}<C text={label} size={size} />{/each}\n`,
      '/C.svelte':
        `<script>\n  let { text, size } = $props();\n</script>\n` + `<span>{text}|{size}</span>\n`,
    };
    const { models, plans } = await analyzeFiles(files);
    const env = models.get('/App.svelte')!.scriptConstEnv;
    // `label` is bound by BOTH the script const and the `{#each as label}` binder,
    // so it is shadowed and excluded; `size` (bound once) is still admitted.
    expect(env.has('label')).toBe(false);
    expect(env.get('size')).toBe('lg');
    // `text={label}` at the call site is the each-binding -> dynamic, never folded.
    expect(plans.get('/C.svelte')!.constFold.has('text')).toBe(false);
    // `size` is a genuine owner const -> folds (the exclusion is precise, not blanket).
    expect(plans.get('/C.svelte')!.constFold.get('size')).toBe('lg');
    await shakeSound(files);
  });

  it('6b. NEGATIVE: a name shadowed by a snippet parameter is not admitted', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n  const label = 'outer';\n</script>\n` +
        `{#snippet row(label)}<Child text={label} />{/snippet}\n{@render row('a')}\n`,
      '/Child.svelte': `<script>\n  let { text } = $props();\n</script>\n<span>{text}</span>\n`,
    };
    const { models, plans } = await analyzeFiles(files);
    // `label` is bound by BOTH the script const and the `{#snippet row(label)}`
    // parameter, so the `{label}` at the call site is the snippet param -> excluded.
    expect(models.get('/App.svelte')!.scriptConstEnv.has('label')).toBe(false);
    expect(plans.get('/Child.svelte')!.constFold.has('text')).toBe(false);
    await shakeSound(files);
  });

  it('7. NEGATIVE: a `$derived` value is out of scope (never unwrapped)', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import C from './C.svelte';\n  let base = $state(1);\n  let d = $derived(base * 2);\n</script>\n` +
        `<C v={d} />\n`,
      '/C.svelte':
        `<script>\n  let { v } = $props();\n</script>\n` +
        `{#if v === 2}<b>two</b>{:else}<i>o</i>{/if}\n`,
    };
    const { models, plans } = await analyzeFiles(files);
    expect(models.get('/App.svelte')!.scriptConstEnv.has('d')).toBe(false);
    expect(plans.get('/C.svelte')!.constFold.has('v')).toBe(false);
    await shakeSound(files);
  });

  it('8. NEGATIVE: object / `$state({...})` initializers are not primitives', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import C from './C.svelte';\n  const obj = { a: 1 };\n  let st = $state({ a: 1 });\n</script>\n` +
        `<C o={obj} s={st} />\n`,
      '/C.svelte':
        `<script>\n  let { o, s } = $props();\n</script>\n` + `<span>{o.a}|{s.a}</span>\n`,
    };
    const { models, plans } = await analyzeFiles(files);
    const env = models.get('/App.svelte')!.scriptConstEnv;
    expect(env.has('obj')).toBe(false); // object literal -> not a Literal
    expect(env.has('st')).toBe(false); // `$state({...})` proxy -> deep-mutable, excluded
    const c = plans.get('/C.svelte')!;
    expect(c.constFold.has('o')).toBe(false);
    expect(c.constFold.has('s')).toBe(false);
    await shakeSound(files);
  });
});
