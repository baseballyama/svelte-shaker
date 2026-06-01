import { afterAll, describe, expect, it } from 'vitest';
import { svelteShaker } from '../src/index';
import { analyze } from '../src/analyze';
import { assertCompiles, cleanTmp, renderHtml } from './diff';

afterAll(() => cleanTmp());

// ----------------------------------------------------------------------
// Regression suite for the adversarial soundness probes (see the task).
//
// Each probe builds an in-memory App -> Child graph, runs the real engine, and
// asserts the shaken Child is SOUND: it still compiles AND server-renders the
// SAME observable HTML as the original for every prop combination that actually
// occurs at the call site.  "Sound" here is satisfied either by a correct
// transform OR by leaving the construct untouched (a conservative bail).
//
// These all share one root cause class the engine previously got wrong: a prop
// NAME colliding with a TEMPLATE-introduced binding (`{#each as}`, snippet
// params, `{#await then}`, `let:`, `{@const}`), an import specifier, a `{@debug}`
// argument, or a `<svelte:component this={X}>` escape.  The fix makes the
// analysis refuse to fold any such prop, so the transform never corrupts it.
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
 * Shake `files` from `/App.svelte` and assert the named child compiles AND
 * renders identical HTML before/after for every prop combo in `combos`.
 * Returns the shaken child source so a caller can add extra assertions.
 */
async function expectSoundChild(
  files: Record<string, string>,
  childId: string,
  combos: Array<Record<string, unknown>>,
): Promise<string> {
  const { resolve, readFile } = memGraph(files);
  const original = readFile(childId);
  const out = await svelteShaker('/App.svelte', resolve, readFile);
  const shaken = out[childId]!;
  const name = childId.slice(childId.lastIndexOf('/') + 1);

  assertCompiles(shaken, name);
  for (const props of combos) {
    const before = await renderHtml(original, props, name);
    const after = await renderHtml(shaken, props, name);
    expect(after, `${name} ${JSON.stringify(props)}`).toBe(before);
  }
  return shaken;
}

describe('soundness probes: template-binding / escape collisions', () => {
  it('each: an index binding `i` shadowing a folded prop `i` is left untouched', async () => {
    // Prop `i={5}` folds, but `{#each items as item, i}` rebinds `i` as the loop
    // index — a different entity. Folding `i === 0` with the PROP would silently
    // delete the first-row arm. The engine must NOT fold `i`.
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n</script>\n` +
        `<Child i={5} items={['a', 'b', 'c']} />\n`,
      '/Child.svelte':
        `<script>\n  let { i = 0, items = [] } = $props();\n</script>\n` +
        `{#each items as item, i}\n` +
        `  <span>{#if i === 0}<b>first</b>{:else}<i>{item}</i>{/if}</span>\n` +
        `{/each}\n`,
    };
    const shaken = await expectSoundChild(files, '/Child.svelte', [
      { i: 5, items: ['a', 'b', 'c'] },
    ]);
    // Untouched: the loop index `i` and the first-row arm survive.
    expect(shaken).toContain('{#each items as item, i}');
    expect(shaken).toContain('first');
    expect(shaken).toMatch(/let \{ i = 0, items = \[\] \}/);
  });

  it('each: a context binding `item` shadowing a folded prop never enters `as`', async () => {
    // `item={false}` would, if folded, both delete `{#if item}` and rewrite the
    // `as item` binding to `as false` (a reserved word) -> compile crash.
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n</script>\n` +
        `<Child item={false} items={['a', 'b']} />\n`,
      '/Child.svelte':
        `<script>\n  let { item = false, items = [] } = $props();\n</script>\n` +
        `<ul>{#each items as item}{#if item}<li>{item}</li>{/if}{/each}</ul>\n`,
    };
    const shaken = await expectSoundChild(files, '/Child.svelte', [
      { item: false, items: ['a', 'b'] },
    ]);
    expect(shaken).toContain('{#each items as item}');
    expect(shaken).not.toContain('as false');
  });

  it('each (keyed): a binding `item` in `as item (item.id)` is not substituted', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n</script>\n` +
        `<Child item="hello" items={[{ id: 1 }, { id: 2 }]} />\n`,
      '/Child.svelte':
        `<script>\n  let { item = 'X', items = [] } = $props();\n</script>\n` +
        `{#each items as item (item.id)}\n  <li>{item.id}</li>\n{/each}\n`,
    };
    const shaken = await expectSoundChild(files, '/Child.svelte', [
      { item: 'hello', items: [{ id: 1 }, { id: 2 }] },
    ]);
    expect(shaken).toContain('{#each items as item (item.id)}');
    expect(shaken).not.toContain('"hello"');
  });

  it('each (destructure): a `{ active, n }` pattern shadowing a folded prop is safe', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n</script>\n` +
        `<Child active={false} items={[{ active: true, n: 1 }, { active: false, n: 2 }]} />\n`,
      '/Child.svelte':
        `<script>\n  let { active = false, items = [] } = $props();\n</script>\n` +
        `{#each items as { active, n }}{#if active}<b>{n}</b>{/if}{/each}\n`,
    };
    const shaken = await expectSoundChild(files, '/Child.svelte', [
      {
        active: false,
        items: [
          { active: true, n: 1 },
          { active: false, n: 2 },
        ],
      },
    ]);
    expect(shaken).toContain('{#each items as { active, n }}');
    expect(shaken).not.toContain('{ false, n }');
  });

  it('snippet: a parameter `label` shadowing a folded prop is not substituted', async () => {
    // `{#snippet row(label)}` would emit `{#snippet row("Z")}` (a literal in a
    // parameter slot) -> "Assigning to rvalue" crash. Must be left untouched.
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n</script>\n` +
        `<Child label="Z" />\n`,
      '/Child.svelte':
        `<script>\n  let { label } = $props();\n</script>\n` +
        `{#snippet row(label)}<li>{label}</li>{/snippet}\n{@render row('alpha')}\n`,
    };
    const shaken = await expectSoundChild(files, '/Child.svelte', [
      { label: 'Z' },
    ]);
    expect(shaken).toContain('{#snippet row(label)}');
    expect(shaken).not.toContain('row("Z")');
    expect(shaken).toMatch(/let \{ label \}/); // kept in signature
  });

  it('await (then): a `then val` binding shadowing a folded prop is left alone', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n</script>\n` +
        `<Child val="Z" p={Promise.resolve('ok')} />\n`,
      '/Child.svelte':
        `<script>\n  let { val = 'X', p } = $props();\n</script>\n` +
        `{#await p then val}<p>{val}</p>{/await}\n`,
    };
    const shaken = await expectSoundChild(files, '/Child.svelte', [
      { val: 'Z', p: Promise.resolve('ok') },
    ]);
    expect(shaken).toContain('{#await p then val}');
    expect(shaken).not.toContain('{"Z"}');
  });

  it('store: a folded prop colliding with an import alias does not corrupt the import', async () => {
    // `import { count as store }` must survive verbatim; the prop `count` folds
    // only in value positions. The import `imported` name is never a prop read.
    const files = {
      '/App.svelte':
        `<script>\n  import C from './C1.svelte';\n</script>\n` +
        `<C count={3} />\n`,
      '/C1.svelte':
        `<script>\n` +
        `  import { count as store } from './store.js';\n` +
        `  let { count = 0 } = $props();\n` +
        `</script>\n\n<p>{count} {$store}</p>\n`,
      '/store.js': `import { readable } from 'svelte/store';\nexport const count = readable(7);\n`,
    };
    // Render only needs the store value; `count` is dropped from the signature.
    // We assert the import is intact and the value folded; SSR of the auto-sub
    // store is environment-sensitive, so we check structure + compile here.
    const { resolve, readFile } = memGraph(files);
    const out = await svelteShaker('/App.svelte', resolve, readFile);
    const shaken = out['/C1.svelte']!;
    assertCompiles(shaken, 'C1.svelte');
    expect(shaken).toContain("import { count as store } from './store.js';");
    expect(shaken).not.toContain('{ 3 as store }'); // import not corrupted
    expect(shaken).toContain('{3}'); // value position folded
    expect(shaken).not.toMatch(/let \{ count/); // prop dropped
  });

  it('debug: a prop used as a `{@debug}` argument is never folded/dropped', async () => {
    // Folding would emit `{@debug "hi"}` (invalid) and also dangle the dropped
    // prop. The engine must bail folding any prop named in a `{@debug}`.
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n</script>\n` +
        `<Child label="hi" />\n`,
      '/Child.svelte':
        `<script>\n  let { label } = $props();\n</script>\n` +
        `{@debug label}\n<p>{label}</p>\n`,
    };
    const shaken = await expectSoundChild(files, '/Child.svelte', [
      { label: 'hi' },
    ]);
    expect(shaken).toContain('{@debug label}'); // bare identifier preserved
    expect(shaken).toMatch(/let \{ label \}/); // prop kept in signature
  });

  it('nested each/if: outer folded `{#if}` + each-binding collision stays sound', async () => {
    // The outer `{#if gate}` (gate=true) unwraps, but the inner `{#each list as
    // item}` binding `item` collides with a same-named prop. `item` must not be
    // folded into the `as` pattern; the outer fold is still applied.
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n</script>\n` +
        `<Child gate={true} item="X" list={['a', 'b']} />\n`,
      '/Child.svelte':
        `<script>\n  let { gate = false, item = 'X', list = [] } = $props();\n</script>\n` +
        `{#if gate}\n  {#each list as item}\n    {#if item === 'go'}<b>{item}</b>{:else}<p>{item}</p>{/if}\n  {/each}\n{/if}\n`,
    };
    const shaken = await expectSoundChild(files, '/Child.svelte', [
      { gate: true, item: 'X', list: ['a', 'b'] },
    ]);
    // `gate` folded true -> outer `{#if}` unwrapped; `item` binding untouched.
    expect(shaken).toContain('{#each list as item}');
    expect(shaken).not.toContain("{#each list as 'X'}");
    expect(shaken).not.toContain('as "X"');
  });
});

describe('soundness probes: dynamic component escape (docs §4.1)', () => {
  it('<svelte:component this={D}> bails D completely; a sibling still folds', async () => {
    // D is reachable both via a normal `<D variant="primary"/>` AND a dynamic
    // `<svelte:component this={D} variant="danger"/>`. The dynamic site is an
    // escape, so D's prop profile is incomplete -> D must be left untouched
    // (else `variant="danger"` renders the wrong arm). Plain (no escape) folds.
    const files = {
      '/App.svelte':
        `<script>\n  import D from './D.svelte';\n  import Plain from './Plain.svelte';\n</script>\n` +
        `<Plain show={false} />\n<D variant="primary" />\n` +
        `<svelte:component this={D} variant="danger" />\n`,
      '/D.svelte':
        `<script>\n  let { variant } = $props();\n</script>\n` +
        `{#if variant === 'danger'}\n  <strong>DANGER</strong>\n` +
        `{:else if variant === 'primary'}\n  <b>P</b>\n{:else}\n  <i>other</i>\n{/if}\n`,
      '/Plain.svelte':
        `<script>\n  let { show } = $props();\n</script>\n` +
        `{#if show}<p>plain visible</p>{/if}<p>plain base</p>\n`,
    };
    const { resolve, readFile } = memGraph(files);
    const { plans } = await analyze('/App.svelte', resolve, readFile);

    // D bails on escape; Plain still folds its boolean.
    const dPlan = plans.get('/D.svelte')!;
    expect(dPlan.bail).toBe(true);
    expect(dPlan.reasons.join()).toContain('escapes as value');
    expect(dPlan.constFold.has('variant')).toBe(false);
    expect(plans.get('/Plain.svelte')!.constFold.get('show')).toBe(false);

    const out = await svelteShaker('/App.svelte', resolve, readFile);
    const dShaken = out['/D.svelte']!;
    const plainShaken = out['/Plain.svelte']!;
    assertCompiles(dShaken, 'D.svelte');
    assertCompiles(plainShaken, 'Plain.svelte');

    // D is untouched, so EVERY variant (including the escaped "danger") renders
    // identically before/after.
    const dOriginal = readFile('/D.svelte');
    for (const variant of ['danger', 'primary', 'other'] as const) {
      const before = await renderHtml(dOriginal, { variant }, 'D.svelte');
      const after = await renderHtml(dShaken, { variant }, 'D.svelte');
      expect(after, variant).toBe(before);
    }
    expect(
      await renderHtml(dShaken, { variant: 'danger' }, 'D.svelte'),
    ).toContain('DANGER');

    // Plain folded soundly for the value that occurs.
    const plainOriginal = readFile('/Plain.svelte');
    expect(await renderHtml(plainShaken, { show: false }, 'Plain.svelte')).toBe(
      await renderHtml(plainOriginal, { show: false }, 'Plain.svelte'),
    );
    expect(plainShaken).not.toContain('plain visible');
  });

  it('benign: a component used ONLY via <svelte:component> is left untouched', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import D from './D.svelte';\n</script>\n` +
        `<svelte:component this={D} variant="danger" />\n`,
      '/D.svelte':
        `<script>\n  let { variant } = $props();\n</script>\n` +
        `{#if variant === 'danger'}<strong>DANGER</strong>{:else}<i>other</i>{/if}\n`,
    };
    const { resolve, readFile } = memGraph(files);
    const out = await svelteShaker('/App.svelte', resolve, readFile);
    const dShaken = out['/D.svelte']!;
    assertCompiles(dShaken, 'D.svelte');
    const dOriginal = readFile('/D.svelte');
    for (const variant of ['danger', 'other'] as const) {
      const before = await renderHtml(dOriginal, { variant }, 'D.svelte');
      const after = await renderHtml(dShaken, { variant }, 'D.svelte');
      expect(after, variant).toBe(before);
    }
  });
});
