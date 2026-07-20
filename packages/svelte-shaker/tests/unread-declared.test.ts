import { afterAll, describe, expect, it } from 'vitest';
import { svelteShaker } from '../src/index';
import { assertCompiles, cleanTmp, renderGraphHtml } from './diff';

afterAll(() => cleanTmp());

// ----------------------------------------------------------------------
// Declared-but-never-read props (docs §PR7).  Where the reverse pass (§PR4)
// removes inputs a child NEVER DECLARES, this pass removes inputs a child
// DECLARES but never READS: the prop is destructured out of `$props()` yet no
// value-position reference to its local binding exists in the instance script or
// template.  Such a prop is invisible to the child, so its call-site attribute is
// dead (transform (a)) and — when it is safe — the declaration itself is dropped
// (transform (b)).
//
// A subtle soundness point pins these tests: Svelte 5 evaluates a `$props()`
// destructure DEFAULT eagerly when the prop is not passed (verified against the
// compiler — a throwing default throws even for an unread prop).  So removing a
// call-site attribute would newly RUN the child's default; the pass only removes
// when that default is side-effect-free (absent / a literal / `undefined`), and a
// non-trivial default (a call) blocks BOTH the attribute removal and the drop.
//
// Every probe runs the real engine over an in-memory App -> … graph and asserts
// BOTH that the expected edit happened AND that the whole program still
// server-renders identical HTML (the soundness oracle).
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
 * Shake `files` from `/App.svelte`, assert the whole graph renders identical
 * HTML before/after (the soundness oracle) and every shaken file compiles, and
 * return the shaken sources merged over the originals.
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

describe('unread declared props: drop props the component never reads', () => {
  it('1. no default: removes the attribute AND drops the declaration', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n  import Heavy from './heavy.js';\n</script>\n` +
        `<Child icon={Heavy} />\n`,
      // `icon` is declared but never read -> both the attribute and the decl go.
      '/Child.svelte': `<script>\n  let { icon } = $props();\n</script>\n` + `<span>x</span>\n`,
      '/heavy.js': `export default 'HEAVY';\n`,
    };
    const out = await shakeSound(files);
    expect(out['/App.svelte']!).not.toContain('icon='); // (a) attribute removed
    expect(out['/App.svelte']!).not.toContain('{Heavy}'); // the import VALUE is no longer referenced
    expect(out['/Child.svelte']!).not.toContain('$props'); // (b) empty signature dropped
  });

  it('2. literal default: removes the attribute AND drops the declaration', async () => {
    const files = {
      // `heavy` / `label` are dynamic entry inputs (unknown `$props()` values), so
      // neither folds — isolating the unread removal of `icon` from const folding.
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n  let { heavy, label } = $props();\n</script>\n` +
        `<Child icon={heavy} label={label} />\n`,
      '/Child.svelte':
        `<script>\n  let { icon = 'default', label } = $props();\n</script>\n` +
        `<span>{label}</span>\n`,
    };
    const out = await shakeSound(files);
    const child = out['/Child.svelte']!;
    expect(out['/App.svelte']!).not.toContain('icon='); // (a) removed (literal default is harmless)
    expect(child).not.toContain('icon'); // (b) `icon` dropped from the signature
    expect(child).toContain('label'); // read prop kept
  });

  it('3. call-expression default: keeps everything (default would newly run — unsound to remove)', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n  let { heavy } = $props();\n</script>\n` +
        `<Child icon={heavy} label="hi" />\n`,
      // A non-trivial default is evaluated eagerly when the prop is omitted, so
      // removing the attribute would run `compute()` where it did not before.
      '/Child.svelte':
        `<script>\n  function compute() { return 'D'; }\n  let { icon = compute(), label } = $props();\n</script>\n` +
        `<span>{label}</span>\n`,
    };
    const out = await shakeSound(files);
    expect(out['/App.svelte']!).toContain('icon={heavy}'); // attribute kept
    expect(out['/Child.svelte']!).toContain('icon = compute()'); // declaration kept
  });

  it('4. `...rest` present: removes the attribute but keeps the declaration', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n  import Heavy from './heavy.js';\n</script>\n` +
        `<Child icon={Heavy} label="hi" />\n`,
      // `icon` is declared (so it never falls into `rest`) and unread; the
      // attribute is removable, but a `...rest` blocks dropping the declaration.
      '/Child.svelte':
        `<script>\n  let { label, icon, ...rest } = $props();\n</script>\n` +
        `<span>{label}|{Object.keys(rest).join(',')}</span>\n`,
      '/heavy.js': `export default 'HEAVY';\n`,
    };
    const out = await shakeSound(files);
    expect(out['/App.svelte']!).not.toContain('icon='); // (a) attribute removed
    expect(out['/App.svelte']!).not.toContain('{Heavy}'); // the import VALUE is no longer referenced
    expect(out['/Child.svelte']!).toContain('icon'); // (b) declaration kept (rest present)
  });

  it('5. read props (template / function / {@debug}) are left untouched', async () => {
    const template = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n  let { heavy } = $props();\n</script>\n` +
        `<Child icon={heavy} />\n`,
      '/Child.svelte':
        `<script>\n  let { icon } = $props();\n</script>\n` + `<span>{icon}</span>\n`,
    };
    expect((await shakeSound(template))['/App.svelte']!).toContain('icon={heavy}');

    const fn = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n  let { heavy } = $props();\n</script>\n` +
        `<Child icon={heavy} />\n`,
      '/Child.svelte':
        `<script>\n  let { icon } = $props();\n  function show() { return icon; }\n</script>\n` +
        `<span>{show()}</span>\n`,
    };
    expect((await shakeSound(fn))['/App.svelte']!).toContain('icon={heavy}');

    const debug = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n  let { heavy } = $props();\n</script>\n` +
        `<Child icon={heavy} />\n`,
      '/Child.svelte':
        `<script>\n  let { icon } = $props();\n</script>\n` + `{@debug icon}\n<span>x</span>\n`,
    };
    expect((await shakeSound(debug))['/App.svelte']!).toContain('icon={heavy}');
  });

  it('6. shadowed by an `{#each as}` binding: left untouched', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n  const heavy = 'H';\n  const list = [1, 2];\n</script>\n` +
        `<Child item={heavy} list={list} />\n`,
      // The prop `item` is never read; the `{item}` inside the loop is the
      // each-binding, a DIFFERENT entity, so we must not touch the prop.
      '/Child.svelte':
        `<script>\n  let { item, list } = $props();\n</script>\n` +
        `{#each list as item}<span>{item}</span>{/each}\n`,
    };
    const out = await shakeSound(files);
    expect(out['/App.svelte']!).toContain('item={heavy}'); // shadowed -> kept
  });

  it('7. written (reassigned) props are kept even when never otherwise read', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n  const heavy = 5;\n</script>\n` +
        `<Child count={heavy} />\n`,
      '/Child.svelte':
        `<script>\n  let { count } = $props();\n  function reset() { count = 0; }\n</script>\n` +
        `<button onclick={reset}>x</button>\n`,
    };
    const out = await shakeSound(files);
    expect(out['/App.svelte']!).toContain('count={heavy}'); // written -> kept
  });

  it('8. parent-side `bind:` site: kept (two-way write contract)', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n  let text = $state('');\n</script>\n` +
        `<Child bind:value={text} />\n`,
      // `value` is declared bindable but never read; the parent `bind:value`
      // makes it a write contract, so neither (a) nor (b) may touch it.
      '/Child.svelte':
        `<script>\n  let { value = $bindable('') } = $props();\n</script>\n` + `<p>hi</p>\n`,
    };
    const out = await shakeSound(files);
    expect(out['/App.svelte']!).toContain('bind:value={text}'); // bind kept
    expect(out['/Child.svelte']!).toContain('value'); // declaration kept
  });

  it('9. referenced only in a TS type position: dropped (types are erased)', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n  import Heavy from './heavy.js';\n</script>\n` +
        `<Child color={Heavy} />\n`,
      // `color` appears only inside a type annotation — a type-level use that is
      // erased at compile, never a runtime value read — so it is unread.
      '/Child.svelte':
        `<script lang="ts">\n  let { color }: { color?: string } = $props();\n</script>\n` +
        `<span>x</span>\n`,
      '/heavy.js': `export default 'HEAVY';\n`,
    };
    const out = await shakeSound(files);
    expect(out['/App.svelte']!).not.toContain('color='); // (a) attribute removed
    expect(out['/App.svelte']!).not.toContain('{Heavy}'); // the import VALUE is no longer referenced
    expect(out['/Child.svelte']!).not.toContain('$props'); // (b) declaration dropped
  });

  it('10. call-expression attribute value: that site keeps the attribute, decl kept', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n  function compute() { return 'x'; }\n</script>\n` +
        `<Child data={compute()} />\n`,
      '/Child.svelte': `<script>\n  let { data } = $props();\n</script>\n` + `<span>y</span>\n`,
    };
    const out = await shakeSound(files);
    expect(out['/App.svelte']!).toContain('data={compute()}'); // side-effecting value -> kept
    expect(out['/Child.svelte']!).toContain('data'); // (b) blocked -> declaration kept
  });

  it('11. spread site keeps its attribute; a plain site is removed and the decl dropped', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n  let { heavy } = $props();\n  const rest = { other: 1 };\n</script>\n` +
        `<Child icon={heavy} />\n<Child {...rest} icon={heavy} />\n`,
      '/Child.svelte': `<script>\n  let { icon } = $props();\n</script>\n` + `<span>z</span>\n`,
    };
    const out = await shakeSound(files);
    const app = out['/App.svelte']!;
    // Plain site: attribute removed. Spread site: attribute kept (spread may set it,
    // but the dropped declaration means the child ignores it regardless).
    expect(app).toMatch(/<Child \/>/); // plain site stripped
    expect(app).toContain('{...rest} icon={heavy}'); // spread site kept verbatim
    expect(out['/Child.svelte']!).not.toContain('$props'); // (b) still drops the declaration
  });

  it('12. a prop forwarded to a grandchild is a value read -> kept (fragment-walk descent)', async () => {
    // The middle component never renders `label` itself — it only FORWARDS it via
    // `<GrandChild inner={label}/>`.  That is still a value-position read, so the
    // prop must stay declared and passed.  If the template walk stopped descending
    // into a `<Child>` attribute, `label` would look unread and be wrongly dropped,
    // dangling the forward — this pins that regression.
    const files = {
      '/App.svelte':
        `<script>\n  import Parent from './Parent.svelte';\n  let { outer } = $props();\n</script>\n` +
        `<Parent label={outer} />\n`,
      '/Parent.svelte':
        `<script>\n  import GrandChild from './GrandChild.svelte';\n  let { label } = $props();\n</script>\n` +
        `<GrandChild inner={label} />\n`,
      '/GrandChild.svelte':
        `<script>\n  let { inner } = $props();\n</script>\n` + `<span>{inner}</span>\n`,
    };
    const out = await shakeSound(files);
    expect(out['/App.svelte']!).toContain('label={outer}'); // forwarded read -> kept at the call site
    const parent = out['/Parent.svelte']!;
    expect(parent).toContain('label'); // declaration kept
    expect(parent).toContain('inner={label}'); // the forward survives
  });

  it('13. exotic template reads ({@const} / {@html} / class: / use:) are reads -> kept', async () => {
    const cases: Record<string, string> = {
      const: `<script>\n  let { size } = $props();\n</script>\n{#each [0] as n}{@const doubled = size * 2}<span>{doubled}{n}</span>{/each}\n`,
      html: `<script>\n  let { size } = $props();\n</script>\n<div>{@html size}</div>\n`,
      klass: `<script>\n  let { size } = $props();\n</script>\n<div class:on={size}>x</div>\n`,
      use: `<script>\n  let { size } = $props();\n  function act() {}\n</script>\n<div use:act={size}>x</div>\n`,
    };
    for (const child of Object.values(cases)) {
      const files = {
        '/App.svelte':
          `<script>\n  import Child from './Child.svelte';\n  let { heavy } = $props();\n</script>\n` +
          `<Child size={heavy} />\n`,
        '/Child.svelte': child,
      };
      const out = await shakeSound(files);
      expect(out['/App.svelte']!).toContain('size={heavy}'); // exotic read -> attribute kept
    }
  });

  it('14. two adjacent unread props drop together with clean comma tiling', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n  let { heavy, keep } = $props();\n</script>\n` +
        `<Child a={heavy} b={heavy} c={keep} />\n`,
      // `a` and `b` are adjacent unread props; dropping the run must not leave a
      // dangling comma in the destructure.  `c` is dynamic + read, so it stays.
      '/Child.svelte':
        `<script>\n  let { a, b, c } = $props();\n</script>\n` + `<span>{c}</span>\n`,
    };
    const out = await shakeSound(files);
    const app = out['/App.svelte']!;
    expect(app).not.toContain('a={heavy}'); // both unread attributes removed
    expect(app).not.toContain('b={heavy}');
    expect(app).toContain('c={keep}'); // read + dynamic kept
    const child = out['/Child.svelte']!;
    expect(child).toContain('let { c } = $props();'); // clean tiling: `a, b` gone, no stray comma
  });
});
