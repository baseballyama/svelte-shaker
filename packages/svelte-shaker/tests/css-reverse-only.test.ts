import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { svelteShaker } from '../src/index';
import { fsResolve } from '../src/scan';
import { assertCompiles, cleanTmp, renderGraphHtml } from './diff';

// ----------------------------------------------------------------------
// CSS pruning on the reverse-ONLY path (docs §PR4/§PR7/§PR8, PR9): a component
// that folds/narrows NOTHING (empty fold env AND empty value-set env) but whose
// body still has a reverse/unread removal used to skip `shakeCss` entirely — the
// early return meant a class SOURCE hiding inside the removed region kept freezing
// CSS removal that never actually applied.  PR9 runs `shakeCss` (with the removed
// region as the pruned set, empty envs) on that path too, so an out-of-set rule
// becomes removable once its only unbounded source is deleted.  The fold-driven
// passes stay skipped — an empty env can fold nothing.
// ----------------------------------------------------------------------

const BASE = join(dirname(fileURLToPath(import.meta.url)), '.shaker-tmp-css-reverse-only');
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

describe('svelte-shaker / CSS pruning on the reverse-only path', () => {
  it('1: a component that folds nothing still prunes once its only unbounded source is reverse-removed', async () => {
    // `Card` takes no props (nothing to fold or narrow), so it used to early-return
    // before `shakeCss`.  Its body passes `<div class={dyn}>` to `Child`, which
    // never reads `children`, so the reverse pass deletes that body.  With that
    // unbounded source gone, the live markup carries only `.btn`, so `.btn-danger`
    // is provably dead and removable — even though the component folds nothing.
    const files = {
      'App.svelte': `<script>\n  import Card from './Card.svelte';\n</script>\n` + `<Card />\n`,
      'Card.svelte':
        `<script>\n  import Child from './Child.svelte';\n  let dyn = Math.random() > 0.5 ? 'p' : 'q';\n</script>\n` +
        `<button class="btn">x</button>\n` +
        `<Child><div class={dyn}>ignored</div></Child>\n` +
        `<style>\n  .btn { font: inherit }\n  .btn-danger { color: red }\n</style>\n`,
      'Child.svelte': `<script>\n  let {} = $props();\n</script>\n<p>child</p>\n`,
    };
    const original = files['Card.svelte'];
    const { get } = await shake(files);
    const shaken = get('Card.svelte');

    expect(shaken).not.toContain('.btn-danger');
    expect(shaken).toContain('.btn');
    expect(shaken).not.toContain('class={dyn}'); // the ignored body was removed
    assertCompiles(shaken, 'Card.svelte');

    const before = await renderGraphHtml(
      { specifier: './Card.svelte', source: original },
      { './Child.svelte': files['Child.svelte'] },
      {},
    );
    const after = await renderGraphHtml(
      { specifier: './Card.svelte', source: shaken },
      { './Child.svelte': files['Child.svelte'] },
      {},
    );
    expect(after).toBe(before);
  });

  it('2: a live unbounded source still freezes removal on the reverse-only path (conservative)', async () => {
    // Same shape, but a genuinely dynamic `class={dyn}` also sits in LIVE markup
    // that always renders.  The reverse pass still deletes the `Child` body, so we
    // enter the CSS path — but the live unbounded source keeps the class set
    // unbounded, so NO rule may be removed.
    const files = {
      'App.svelte': `<script>\n  import Card from './Card.svelte';\n</script>\n` + `<Card />\n`,
      'Card.svelte':
        `<script>\n  import Child from './Child.svelte';\n  let dyn = Math.random() > 0.5 ? 'p' : 'q';\n</script>\n` +
        `<button class="btn">x</button>\n` +
        `<span class={dyn}>live</span>\n` +
        `<Child><div>ignored</div></Child>\n` +
        `<style>\n  .btn { font: inherit }\n  .btn-danger { color: red }\n</style>\n`,
      'Child.svelte': `<script>\n  let {} = $props();\n</script>\n<p>child</p>\n`,
    };
    const { get } = await shake(files);
    const shaken = get('Card.svelte');

    // Live unbounded source -> conservative: keep every rule.
    expect(shaken).toContain('.btn-danger');
    expect(shaken).toContain('.btn');
    assertCompiles(shaken, 'Card.svelte');
  });

  it('3: no fold and no reverse removal leaves the component byte-identical (early-return regression)', async () => {
    // Empty fold env, empty value sets, and NO reverse/unread removal: nothing seeds
    // a pruned region, so the component must be left exactly as written — even the
    // never-produced `.btn-danger` stays (Svelte's own unused-CSS pruning handles
    // it later).  This pins the early return we keep when there is nothing to prune.
    const files = {
      'App.svelte':
        `<script>\n  import Widget from './Widget.svelte';\n</script>\n` + `<Widget />\n`,
      'Widget.svelte':
        `<script>\n  let msg = 'hi';\n</script>\n` +
        `<button class="btn">{msg}</button>\n` +
        `<style>\n  .btn { font: inherit }\n  .btn-danger { color: red }\n</style>\n`,
    };
    const original = files['Widget.svelte'];
    const { get } = await shake(files);
    const shaken = get('Widget.svelte');

    expect(shaken).toBe(original); // untouched: byte-identical
    assertCompiles(shaken, 'Widget.svelte');
  });

  it('4: fold AND reverse removal in the same component go through the full path', async () => {
    // `flag` is always `true` at both call sites, so it folds and `{#if flag}`
    // collapses to its kept arm (`.on` stays).  The `Child` body is reverse-removed
    // (dropping `class={dyn}`), so with `.on` and `.btn` the only possible classes,
    // `.btn-danger` is removed — exercising the fold path and the reverse removal
    // together (env non-empty -> NOT the reverse-only branch).
    const files = {
      'App.svelte':
        `<script>\n  import Card from './Card.svelte';\n</script>\n` +
        `<Card flag={true} />\n<Card flag={true} />\n`,
      'Card.svelte':
        `<script>\n  import Child from './Child.svelte';\n  let { flag } = $props();\n  let dyn = Math.random() > 0.5 ? 'p' : 'q';\n</script>\n` +
        `<button class="btn">x</button>\n` +
        `{#if flag}<div class="on">y</div>{/if}\n` +
        `<Child><div class={dyn}>ignored</div></Child>\n` +
        `<style>\n  .btn { font: inherit }\n  .on { color: green }\n  .btn-danger { color: red }\n</style>\n`,
      'Child.svelte': `<script>\n  let {} = $props();\n</script>\n<p>child</p>\n`,
    };
    const original = files['Card.svelte'];
    const { get } = await shake(files);
    const shaken = get('Card.svelte');

    expect(shaken).not.toContain('.btn-danger');
    expect(shaken).toContain('.on');
    expect(shaken).toContain('.btn');
    expect(shaken).not.toContain('class={dyn}');
    assertCompiles(shaken, 'Card.svelte');

    const before = await renderGraphHtml(
      { specifier: './Card.svelte', source: original },
      { './Child.svelte': files['Child.svelte'] },
      { flag: true },
    );
    const after = await renderGraphHtml(
      { specifier: './Card.svelte', source: shaken },
      { './Child.svelte': files['Child.svelte'] },
      { flag: true },
    );
    expect(after).toBe(before);
  });
});
