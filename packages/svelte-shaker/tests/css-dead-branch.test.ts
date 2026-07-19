import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { svelteShaker } from '../src/index';
import { fsResolve } from '../src/scan';
import { assertCompiles, cleanTmp, renderHtml, renderGraphHtml } from './diff';

// ----------------------------------------------------------------------
// CSS dead-branch pruning (docs §3, PR8): `computePossibleClasses` must not count
// a class SOURCE that lives inside a region the transform actually deletes — a
// folded-away `{#if}` arm, or a reverse/unread removal region.  Such markup never
// renders, so its class can never be carried by any element; excluding it shrinks
// the possible-class set and, crucially, lets an UNBOUNDED source hiding in a dead
// arm stop blocking every CSS removal.  The headline win (case 2): an interpolated
// `class={dynamic}` inside a dead branch no longer freezes the whole component.
// ----------------------------------------------------------------------

const BASE = join(dirname(fileURLToPath(import.meta.url)), '.shaker-tmp-css-dead');
const readFile = (id: string) => readFileSync(id, 'utf-8');
let seq = 0;

/** Write `files` into a fresh dir and shake from `App.svelte`; return by basename. */
async function shake(files: Record<string, string>): Promise<{
  dir: string;
  out: Record<string, string>;
  get: (name: string) => string;
}> {
  const dir = join(BASE, `case-${seq++}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  const out = await svelteShaker(join(dir, 'App.svelte'), fsResolve, readFile);
  return { dir, out, get: (name: string) => out[join(dir, name)]! };
}

afterAll(() => {
  rmSync(BASE, { recursive: true, force: true });
  cleanTmp();
});

describe('svelte-shaker / CSS dead-branch pruning', () => {
  it('1: a static class only in a folded-away `{#if}` arm is dropped from CSS', async () => {
    // `mode="a"` at the single call site -> `{#if mode === 'b'}` is provably dead
    // and deleted, so `.only-b` can never be produced and its rule can go.
    const files = {
      'App.svelte': `<script>\n  import Btn from './Btn.svelte';\n</script>\n<Btn mode="a" />\n`,
      'Btn.svelte':
        `<script>\n  let { mode } = $props();\n</script>\n` +
        `<div class="always">y</div>\n` +
        `{#if mode === 'b'}<div class="only-b">x</div>{/if}\n` +
        `<style>\n  .always { color: blue }\n  .only-b { color: red }\n</style>\n`,
    };
    const original = files['Btn.svelte'];
    const { get } = await shake(files);
    const shaken = get('Btn.svelte');

    expect(shaken).not.toContain('.only-b');
    expect(shaken).toContain('.always');
    assertCompiles(shaken, 'Btn.svelte');

    const before = await renderHtml(original, { mode: 'a' }, 'Btn.svelte');
    const after = await renderHtml(shaken, {}, 'Btn.svelte');
    expect(after).toBe(before);
  });

  it('2: an UNBOUNDED source in a dead arm no longer freezes CSS removal', async () => {
    // The live button narrows to `btn-{sm|lg}`; a genuinely dynamic `class={dyn}`
    // sits inside the dead `{#if mode === 'b'}` arm.  Before PR8 that unbounded
    // source froze the whole component (nothing removed); after, the dead arm is
    // pruned and `.btn-danger` (outside the narrowed set) is removed.
    const files = {
      'App.svelte':
        `<script>\n  import Btn from './Btn.svelte';\n</script>\n` +
        `<Btn mode="a" size="sm" />\n<Btn mode="a" size="lg" />\n`,
      'Btn.svelte':
        `<script>\n  let { mode, size } = $props();\n  let dyn = Math.random() > 0.5 ? 'p' : 'q';\n</script>\n` +
        `<button class="btn btn-{size}">x</button>\n` +
        `{#if mode === 'b'}<span class={dyn}>d</span>{/if}\n` +
        `<style>\n  .btn { font: inherit }\n  .btn-sm { color: green }\n  .btn-lg { color: teal }\n  .btn-danger { color: red }\n</style>\n`,
    };
    const original = files['Btn.svelte'];
    const { get } = await shake(files);
    const shaken = get('Btn.svelte');

    expect(shaken).not.toContain('.btn-danger');
    expect(shaken).toContain('.btn-sm');
    expect(shaken).toContain('.btn-lg');
    expect(shaken).toMatch(/\.btn\s*\{/);
    expect(shaken).not.toContain('class={dyn}'); // the dead arm is gone
    assertCompiles(shaken, 'Btn.svelte');

    for (const size of ['sm', 'lg'] as const) {
      const before = await renderHtml(original, { mode: 'a', size }, 'Btn.svelte');
      const after = await renderHtml(shaken, { size }, 'Btn.svelte');
      expect(after, size).toBe(before);
    }
  });

  it('3: a spread attribute in a dead arm no longer freezes CSS removal', async () => {
    // `{...rest}` could carry `class`, so it is an unbounded source — but only in
    // the dead arm, which is pruned; `.btn-danger` is removed.
    const files = {
      'App.svelte':
        `<script>\n  import Btn from './Btn.svelte';\n</script>\n` +
        `<Btn mode="a" size="sm" />\n<Btn mode="a" size="lg" />\n`,
      'Btn.svelte':
        `<script>\n  let { mode, size, ...rest } = $props();\n</script>\n` +
        `<button class="btn btn-{size}">x</button>\n` +
        `{#if mode === 'b'}<span {...rest}>d</span>{/if}\n` +
        `<style>\n  .btn { font: inherit }\n  .btn-sm { color: green }\n  .btn-lg { color: teal }\n  .btn-danger { color: red }\n</style>\n`,
    };
    const original = files['Btn.svelte'];
    const { get } = await shake(files);
    const shaken = get('Btn.svelte');

    expect(shaken).not.toContain('.btn-danger');
    expect(shaken).toContain('.btn-sm');
    expect(shaken).toContain('.btn-lg');
    assertCompiles(shaken, 'Btn.svelte');

    for (const size of ['sm', 'lg'] as const) {
      const before = await renderHtml(original, { mode: 'a', size }, 'Btn.svelte');
      const after = await renderHtml(shaken, { size }, 'Btn.svelte');
      expect(after, size).toBe(before);
    }
  });

  it('4: an unbounded source in LIVE markup still freezes CSS removal (bail)', async () => {
    // The dynamic `class={dyn}` here is NOT in a dead arm — it always renders — so
    // the component stays unbounded and NO rule may be removed.
    const files = {
      'App.svelte':
        `<script>\n  import Btn from './Btn.svelte';\n</script>\n` +
        `<Btn mode="a" size="sm" />\n<Btn mode="a" size="lg" />\n`,
      'Btn.svelte':
        `<script>\n  let { mode, size } = $props();\n  let dyn = Math.random() > 0.5 ? 'p' : 'q';\n</script>\n` +
        `<button class="btn btn-{size}">x</button>\n` +
        `<span class={dyn}>live</span>\n` +
        `{#if mode === 'b'}<b>d</b>{/if}\n` +
        `<style>\n  .btn { font: inherit }\n  .btn-sm { color: green }\n  .btn-danger { color: red }\n</style>\n`,
    };
    const { get } = await shake(files);
    const shaken = get('Btn.svelte');

    // Live unbounded source -> conservative: keep every rule.
    expect(shaken).toContain('.btn-danger');
    expect(shaken).toContain('.btn-sm');
    assertCompiles(shaken, 'Btn.svelte');
  });

  it('5: when the `{:else}` arm survives, its class is still counted (kept)', async () => {
    // `mode="a"` -> the `{#if mode === 'b'}` head is dead and the `{:else}` arm is
    // kept, re-emitted verbatim.  The kept arm's `.a-only` must NOT be pruned
    // (that would wrongly delete a live rule); `.b-only`/`.ghost` are removed.
    const files = {
      'App.svelte': `<script>\n  import Btn from './Btn.svelte';\n</script>\n<Btn mode="a" />\n`,
      'Btn.svelte':
        `<script>\n  let { mode } = $props();\n</script>\n` +
        `{#if mode === 'b'}<div class="b-only">B</div>{:else}<div class="a-only">A</div>{/if}\n` +
        `<style>\n  .a-only { color: green }\n  .b-only { color: red }\n  .ghost { color: gray }\n</style>\n`,
    };
    const original = files['Btn.svelte'];
    const { get } = await shake(files);
    const shaken = get('Btn.svelte');

    expect(shaken).toContain('.a-only'); // the surviving arm's class is preserved
    expect(shaken).not.toContain('.b-only');
    expect(shaken).not.toContain('.ghost');
    assertCompiles(shaken, 'Btn.svelte');

    const before = await renderHtml(original, { mode: 'a' }, 'Btn.svelte');
    const after = await renderHtml(shaken, {}, 'Btn.svelte');
    expect(after).toBe(before);
  });

  it('6: a class source in a reverse-removed body is excluded (PR4 + PR8)', async () => {
    // `Card` passes body content to `Child`, but `Child` never reads `children`,
    // so the reverse pass deletes the `<div class={dyn}>` body node.  With that
    // unbounded source gone, Card's own `.btn-danger` becomes removable.
    const files = {
      'App.svelte':
        `<script>\n  import Card from './Card.svelte';\n</script>\n` +
        `<Card size="sm" />\n<Card size="lg" />\n`,
      'Card.svelte':
        `<script>\n  import Child from './Child.svelte';\n  let { size } = $props();\n  let dyn = Math.random() > 0.5 ? 'p' : 'q';\n</script>\n` +
        `<button class="btn btn-{size}">x</button>\n` +
        `<Child><div class={dyn}>ignored</div></Child>\n` +
        `<style>\n  .btn { font: inherit }\n  .btn-sm { color: green }\n  .btn-lg { color: teal }\n  .btn-danger { color: red }\n</style>\n`,
      'Child.svelte': `<script>\n  let {} = $props();\n</script>\n<p>child</p>\n`,
    };
    const original = files['Card.svelte'];
    const { get } = await shake(files);
    const shaken = get('Card.svelte');

    expect(shaken).not.toContain('.btn-danger');
    expect(shaken).toContain('.btn-sm');
    expect(shaken).not.toContain('class={dyn}'); // the ignored body was removed
    assertCompiles(shaken, 'Card.svelte');

    for (const size of ['sm', 'lg'] as const) {
      const before = await renderGraphHtml(
        { specifier: './Card.svelte', source: original },
        { './Child.svelte': files['Child.svelte'] },
        { size },
      );
      const after = await renderGraphHtml(
        { specifier: './Card.svelte', source: shaken },
        { './Child.svelte': files['Child.svelte'] },
        { size },
      );
      expect(after, size).toBe(before);
    }
  });

  it('7: `:global` rules and class-less selectors are untouched (regression)', async () => {
    // The dead-arm pruning changes only which CLASSES are possible; it must not
    // disturb the existing `:global`/element-selector guards.
    const files = {
      'App.svelte': `<script>\n  import Btn from './Btn.svelte';\n</script>\n<Btn mode="a" />\n`,
      'Btn.svelte':
        `<script>\n  let { mode } = $props();\n</script>\n` +
        `<div class="always">y</div>\n` +
        `{#if mode === 'b'}<div class="only-b">x</div>{/if}\n` +
        `<style>\n  .always { color: blue }\n  .only-b { color: red }\n  div { margin: 0 }\n  :global(.only-b) { color: pink }\n</style>\n`,
    };
    const { get } = await shake(files);
    const shaken = get('Btn.svelte');

    expect(shaken).not.toContain('  .only-b {'); // the scoped `.only-b` rule is gone
    expect(shaken).toContain(':global(.only-b)'); // but the :global one stays
    expect(shaken).toContain('div { margin: 0 }'); // element-only rule stays
    assertCompiles(shaken, 'Btn.svelte');
  });
});
