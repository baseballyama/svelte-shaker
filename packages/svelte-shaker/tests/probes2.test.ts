import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import { svelteShaker } from '../src/index';
import { analyze } from '../src/analyze';
import { evaluateWithSets } from '../src/eval';
import { parseSvelte, type AnyNode } from '../src/parse';
import type { Literal } from '../src/ir';
import { assertCompiles, cleanTmp, renderHtml } from './diff';

const TMP = join(
  dirname(fileURLToPath(import.meta.url)),
  `.probes2-tmp-${process.env['VITEST_WORKER_ID'] ?? String(process.pid)}`,
);

afterAll(() => cleanTmp());
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

// ----------------------------------------------------------------------
// Regression suite for the second batch of adversarial soundness probes.
//
// Each was confirmed UNSOUND or a hard build break against the real engine.
// "Sound" is satisfied either by a correct transform OR by leaving the
// construct untouched (a conservative bail).  Every render-based case compares
// ORIGINAL vs SHAKEN server HTML for every prop value that actually occurs.
// ----------------------------------------------------------------------

/** Minimal in-memory module graph (POSIX-style absolute ids). */
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

async function shake(files: Record<string, string>): Promise<{
  out: Record<string, string>;
  readFile: (id: string) => string;
}> {
  const { resolve, readFile } = memGraph(files);
  const out = await svelteShaker('/App.svelte', resolve, readFile);
  return { out, readFile };
}

/** Assert the shaken child compiles AND renders identically for every combo. */
async function expectSound(
  out: Record<string, string>,
  readFile: (id: string) => string,
  childId: string,
  combos: Array<Record<string, unknown>>,
): Promise<string> {
  const original = readFile(childId);
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

// ----------------------------------------------------------------------
// 1. barrel-import: a child reached BOTH via a direct default import AND via a
//    `.js` barrel re-export.  The barrel `<Comp/>` site is invisible to the
//    value-set scan, so folding/narrowing on the visible site alone is unsound.
//    The engine must bail the child.
// ----------------------------------------------------------------------

describe('probe: barrel-import (mixed direct + barrel re-export)', () => {
  it('mixed default+barrel narrowing: child is bailed, both variants render right', async () => {
    const files = {
      '/App.svelte':
        `<script>\n` +
        `  import Child from './Child.svelte';\n` +
        `  import { Child as ChildB } from './lib.js';\n` +
        `</script>\n` +
        `<Child x={1} />\n<ChildB x={2} />\n`,
      '/lib.js': `export { default as Child } from "./Child.svelte";\n`,
      '/Child.svelte':
        `<script>\n  let { x = 0 } = $props();\n</script>\n` +
        `{#if x === 1}<p>ONE</p>{:else if x === 2}<p>TWO</p>{:else}<p>?</p>{/if}\n`,
    };
    const { resolve, readFile } = memGraph(files);
    const { plans } = await analyze('/App.svelte', resolve, readFile);
    const plan = plans.get('/Child.svelte')!;
    // The hidden barrel site makes the child unobservable -> full bail.
    expect(plan.bail).toBe(true);
    expect(plan.reasons.join()).toContain('barrel');
    expect(plan.constFold.has('x')).toBe(false);
    expect(plan.narrow.has('x')).toBe(false);

    const out = await svelteShaker('/App.svelte', resolve, readFile);
    // Both occurring values render the correct arm (x=2 must stay TWO).
    await expectSound(out, readFile, '/Child.svelte', [{ x: 1 }, { x: 2 }]);
    expect(await renderHtml(out['/Child.svelte']!, { x: 2 }, 'Child.svelte')).toContain('TWO');
  });

  it('mixed default+barrel constFold+drop: barrel value keeps its branch', async () => {
    const files = {
      '/App.svelte':
        `<script>\n` +
        `  import Child from './Child.svelte';\n` +
        `  import { Child as ChildB } from './lib.js';\n` +
        `</script>\n` +
        `<Child label="direct" />\n<ChildB label="barrel" />\n`,
      '/lib.js': `export { default as Child } from "./Child.svelte";\n`,
      '/Child.svelte':
        `<script>\n  let { label = '?' } = $props();\n</script>\n` + `<p>{label}</p>\n`,
    };
    const { out, readFile } = await shake(files);
    const shaken = await expectSound(out, readFile, '/Child.svelte', [
      { label: 'direct' },
      { label: 'barrel' },
    ]);
    // The prop must survive (still used by the barrel route).
    expect(shaken).toMatch(/let \{ label/);
  });

  it('re-export of a local default import (`export { D as Child }`) also bails', async () => {
    const files = {
      '/App.svelte':
        `<script>\n` +
        `  import Child from './Child.svelte';\n` +
        `  import { Child as ChildB } from './lib.js';\n` +
        `</script>\n` +
        `<Child variant="primary" />\n<ChildB variant="secondary" />\n`,
      '/lib.js': `import D from './Child.svelte';\nexport { D as Child };\n`,
      '/Child.svelte':
        `<script>\n  let { variant = 'primary' } = $props();\n</script>\n` +
        `{#if variant === 'primary'}<b>P</b>{:else if variant === 'secondary'}<i>S</i>{:else}<u>O</u>{/if}\n`,
    };
    const { resolve, readFile } = memGraph(files);
    const { plans } = await analyze('/App.svelte', resolve, readFile);
    expect(plans.get('/Child.svelte')!.bail).toBe(true);

    const out = await svelteShaker('/App.svelte', resolve, readFile);
    await expectSound(out, readFile, '/Child.svelte', [
      { variant: 'primary' },
      { variant: 'secondary' },
    ]);
    expect(
      await renderHtml(out['/Child.svelte']!, { variant: 'secondary' }, 'Child.svelte'),
    ).toContain('S');
  });

  it('pure-barrel only (no direct import) still folds the directly-reached sibling', async () => {
    // Control: a sibling reached only directly must still fold normally; the
    // barrel bail must not over-reach.
    const files = {
      '/App.svelte':
        `<script>\n` +
        `  import Plain from './Plain.svelte';\n` +
        `</script>\n` +
        `<Plain show={false} />\n`,
      '/Plain.svelte':
        `<script>\n  let { show = true } = $props();\n</script>\n` +
        `{#if show}<p>vis</p>{/if}<p>base</p>\n`,
    };
    const { resolve, readFile } = memGraph(files);
    const { plans } = await analyze('/App.svelte', resolve, readFile);
    expect(plans.get('/Plain.svelte')!.constFold.get('show')).toBe(false);
    const out = await svelteShaker('/App.svelte', resolve, readFile);
    await expectSound(out, readFile, '/Plain.svelte', [{ show: false }]);
    expect(out['/Plain.svelte']!).not.toContain('vis');
  });
});

// ----------------------------------------------------------------------
// 2. derived-effect: a folded prop whose name is shadowed by a function/arrow
//    PARAMETER in the instance script must NOT be substituted into the param
//    slot (invalid Svelte, semantically wrong).
// ----------------------------------------------------------------------

describe('probe: callback-parameter shadowing a folded prop', () => {
  it('$effect arrow param `(x) =>` shadowing prop `x` is left untouched', async () => {
    const files = {
      '/App.svelte': `<script>\n  import Child from './Child.svelte';\n</script>\n<Child x={1} />\n`,
      '/Child.svelte':
        `<script>\n  let { x = 0 } = $props();\n` +
        `  $effect(() => { const f = (x) => x + 100; void f; });\n</script>\n<p>ok</p>\n`,
    };
    const { out, readFile } = await shake(files);
    const shaken = await expectSound(out, readFile, '/Child.svelte', [{ x: 1 }]);
    expect(shaken).toContain('(x) => x + 100'); // param + body untouched
    expect(shaken).not.toContain('(1) =>');
  });

  it('$derived.by reduce callback `(acc, item) =>` shadowing prop `item` is safe', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n</script>\n` +
        `<Child item={1} list={[{ n: 7 }, { n: 3 }]} />\n`,
      '/Child.svelte':
        `<script>\n  let { item = 0, list = [] } = $props();\n` +
        `  let total = $derived.by(() => list.reduce((acc, item) => acc + item.n, 0));\n</script>\n` +
        `<p>{total}</p>\n`,
    };
    const { out, readFile } = await shake(files);
    const shaken = await expectSound(out, readFile, '/Child.svelte', [
      { item: 1, list: [{ n: 7 }, { n: 3 }] },
    ]);
    expect(shaken).toContain('(acc, item) =>');
    expect(shaken).not.toContain('(acc, 1)');
    expect(shaken).not.toContain('1.n');
  });

  it('function-declaration param shadowing a folded prop is left untouched', async () => {
    const files = {
      '/App.svelte': `<script>\n  import Child from './Child.svelte';\n</script>\n<Child y={2} />\n`,
      '/Child.svelte':
        `<script>\n  let { y = 0 } = $props();\n` +
        `  function g(y) { return y + 1; }\n  const r = g(5);\n</script>\n<p>{r}</p>\n`,
    };
    const { out, readFile } = await shake(files);
    const shaken = await expectSound(out, readFile, '/Child.svelte', [{ y: 2 }]);
    expect(shaken).toContain('function g(y)');
    expect(shaken).not.toContain('function g(2)');
  });

  it('destructuring param `({ k }) =>` shadowing a folded prop is left untouched', async () => {
    const files = {
      '/App.svelte': `<script>\n  import Child from './Child.svelte';\n</script>\n<Child k={3} />\n`,
      '/Child.svelte':
        `<script>\n  let { k = 0 } = $props();\n` +
        `  const f = ({ k }) => k + 1;\n  const r = f({ k: 9 });\n</script>\n<p>{r}</p>\n`,
    };
    const { out, readFile } = await shake(files);
    const shaken = await expectSound(out, readFile, '/Child.svelte', [{ k: 3 }]);
    expect(shaken).toContain('({ k }) =>');
    expect(shaken).not.toContain('({ 3 }) =>');
  });

  it('a folded prop NOT shadowed by any callback param still folds into a derived', async () => {
    // Control: the param fix must not block the normal (sound) substitution.
    const files = {
      '/App.svelte': `<script>\n  import Child from './Child.svelte';\n</script>\n<Child base={10} />\n`,
      '/Child.svelte':
        `<script>\n  let { base = 0 } = $props();\n` +
        `  let doubled = $derived(base * 2);\n</script>\n<p>{doubled}</p>\n`,
    };
    const { out, readFile } = await shake(files);
    const shaken = await expectSound(out, readFile, '/Child.svelte', [{ base: 10 }]);
    expect(shaken).toContain('$derived(10 * 2)'); // folded
    expect(shaken).not.toMatch(/let \{ base/); // dropped
  });
});

// ----------------------------------------------------------------------
// 3. numeric-narrow: loose-equality (`==` / `!=`) value-set narrowing must
//    honor JS coercion, not strict comparison.
// ----------------------------------------------------------------------

describe('probe: loose-equality coercion in set narrowing', () => {
  function expr(src: string): AnyNode {
    const ast = parseSvelte(`{${src}}`, 'expr.svelte');
    const tag = ast.fragment.nodes?.find((n) => n.type === 'ExpressionTag');
    if (!tag?.expression) throw new Error(`no expression in {${src}}`);
    return tag.expression;
  }
  const consts = (o: Record<string, Literal>) => new Map(Object.entries(o));
  const sets = (o: Record<string, Literal[]>) => new Map(Object.entries(o));
  const empty = consts({});

  it('`n == false` over {0,1} is UNKNOWN (0 == false is true at runtime)', () => {
    expect(evaluateWithSets(expr('n == false'), empty, sets({ n: [0, 1] })).known).toBe(false);
  });

  it("`n == ''` over {0,2} is UNKNOWN (0 == '' is true)", () => {
    expect(evaluateWithSets(expr("n == ''"), empty, sets({ n: [0, 2] })).known).toBe(false);
  });

  it('`x == undefined` over {null,1} is UNKNOWN (null == undefined is true)', () => {
    expect(evaluateWithSets(expr('x == undefined'), empty, sets({ x: [null, 1] })).known).toBe(
      false,
    );
  });

  it('`b == 1` over {true,false} is UNKNOWN (true == 1 is true)', () => {
    expect(evaluateWithSets(expr('b == 1'), empty, sets({ b: [true, false] })).known).toBe(false);
  });

  it("`n != ''` over {0,1} is UNKNOWN (negation path; 0 != '' is false)", () => {
    expect(evaluateWithSets(expr("n != ''"), empty, sets({ n: [0, 1] })).known).toBe(false);
  });

  it('strict `===` set narrowing stays correct (lit ∉ set -> provably false)', () => {
    expect(evaluateWithSets(expr('n === 2'), empty, sets({ n: [0, 1] }))).toEqual({
      known: true,
      value: false,
    });
  });

  it('loose `==` is still provably FALSE when no member can coerce-match', () => {
    // No member of {1,2} loosely equals 'x', so the arm is genuinely dead.
    expect(evaluateWithSets(expr("n == 'x'"), empty, sets({ n: [1, 2] }))).toEqual({
      known: true,
      value: false,
    });
  });

  it('end-to-end: `{#if n == false}` over occurring {0,1} keeps the live arm', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n</script>\n` +
        `<Child n={0} />\n<Child n={1} />\n`,
      '/Child.svelte':
        `<script>\n  let { n } = $props();\n</script>\n` +
        `{#if n == false}<b>ZEROish</b>{:else}<i>other</i>{/if}\n`,
    };
    const { out, readFile } = await shake(files);
    const shaken = await expectSound(out, readFile, '/Child.svelte', [{ n: 0 }, { n: 1 }]);
    // n=0 hits the loose-equality arm at runtime, so it must survive.
    expect(shaken).toContain('ZEROish');
    expect(await renderHtml(shaken, { n: 0 }, 'Child.svelte')).toContain('ZEROish');
  });
});

// ----------------------------------------------------------------------
// 4. props-same-line: `$props()` as one declarator of a multi-declarator
//    statement.  Dropping the empty signature would delete the sibling binding.
// ----------------------------------------------------------------------

describe('probe: $props() sharing a multi-declarator statement', () => {
  it('`let { x } = $props(), y = 1;` is bailed; sibling `y` survives', async () => {
    const files = {
      '/App.svelte': `<script>\n  import Child from './Child.svelte';\n</script>\n<Child x={false} />\n`,
      '/Child.svelte':
        `<script>\n  let { x } = $props(), y = 1;\n</script>\n` +
        `{#if x}<p>ON</p>{:else}<p>OFF {y}</p>{/if}\n`,
    };
    const { resolve, readFile } = memGraph(files);
    const { plans } = await analyze('/App.svelte', resolve, readFile);
    expect(plans.get('/Child.svelte')!.bail).toBe(true);

    const out = await svelteShaker('/App.svelte', resolve, readFile);
    const shaken = await expectSound(out, readFile, '/Child.svelte', [{ x: false }]);
    // The whole declaration (incl. `y = 1`) is left intact.
    expect(shaken).toContain('let { x } = $props(), y = 1;');
    // The call-site attribute must NOT be removed (child kept its prop).
    expect(out['/App.svelte']!).toContain('x={false}');
  });

  it('`let y = 1, { x } = $props();` (props last) is also bailed soundly', async () => {
    const files = {
      '/App.svelte': `<script>\n  import Child from './Child.svelte';\n</script>\n<Child x={false} />\n`,
      '/Child.svelte':
        `<script>\n  let y = 1, { x } = $props();\n</script>\n` +
        `{#if x}<p>ON</p>{:else}<p>OFF {y}</p>{/if}\n`,
    };
    const { out, readFile } = await shake(files);
    const shaken = await expectSound(out, readFile, '/Child.svelte', [{ x: false }]);
    expect(shaken).toContain('let y = 1, { x } = $props();');
  });

  it('sole-declarator `let { x } = $props();` still folds + drops normally', async () => {
    // Control: the multi-declarator bail must not regress the common case.
    const files = {
      '/App.svelte': `<script>\n  import Child from './Child.svelte';\n</script>\n<Child x={false} />\n`,
      '/Child.svelte':
        `<script>\n  let { x } = $props();\n</script>\n` +
        `{#if x}<p>ON</p>{:else}<p>OFF</p>{/if}\n`,
    };
    const { out, readFile } = await shake(files);
    const shaken = await expectSound(out, readFile, '/Child.svelte', [{ x: false }]);
    expect(shaken).not.toMatch(/let \{ x \}/); // dropped
  });
});

// ----------------------------------------------------------------------
// 5. snippet-children: `children` and named-snippet props are supplied through
//    the element BODY, not attributes.  They must never fold to `undefined`.
// ----------------------------------------------------------------------

describe('probe: body-synthesized children / snippet props', () => {
  it('`children` from body content is kept (not folded to undefined)', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Box from './Box.svelte';\n</script>\n` + `<Box>hello world</Box>\n`,
      '/Box.svelte':
        `<script>\n  let { loading = false, children } = $props();\n</script>\n` +
        `<div>{#if loading}<span>L</span>{/if}{@render children?.()}</div>\n`,
    };
    const { resolve, readFile } = memGraph(files);
    const { plans } = await analyze('/App.svelte', resolve, readFile);
    const plan = plans.get('/Box.svelte')!;
    // `loading` still folds (only passed via nothing -> default false), but
    // `children` must be neither folded nor dropped.
    expect(plan.constFold.has('children')).toBe(false);
    expect(plan.constFold.get('loading')).toBe(false);

    const out = await svelteShaker('/App.svelte', resolve, readFile);
    const shaken = out['/Box.svelte']!;
    assertCompiles(shaken, 'Box.svelte');
    expect(shaken).toMatch(/children/); // children kept in signature
    expect(shaken).toContain('@render children');

    // End-to-end render of the App graph: the slotted content survives.
    const before = await renderApp(files, '/App.svelte');
    const after = await renderAppWith(files, out, '/App.svelte');
    expect(after).toBe(before);
    expect(after).toContain('hello world');
  });

  it('a named `{#snippet header()}` in the body keeps the `header` prop', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Box from './Box.svelte';\n</script>\n` +
        `<Box>{#snippet header()}<h1>HI</h1>{/snippet}</Box>\n`,
      '/Box.svelte':
        `<script>\n  let { header } = $props();\n</script>\n` +
        `<div>{#if header}{@render header()}{:else}none{/if}</div>\n`,
    };
    const { resolve, readFile } = memGraph(files);
    const { plans } = await analyze('/App.svelte', resolve, readFile);
    expect(plans.get('/Box.svelte')!.constFold.has('header')).toBe(false);

    const out = await svelteShaker('/App.svelte', resolve, readFile);
    const shaken = out['/Box.svelte']!;
    assertCompiles(shaken, 'Box.svelte');
    const before = await renderApp(files, '/App.svelte');
    const after = await renderAppWith(files, out, '/App.svelte');
    expect(after).toBe(before);
    expect(after).toContain('HI');
  });

  it('a self-closing child with no body still folds the (genuinely-default) prop', async () => {
    // Control: whitespace/no body must NOT spuriously keep `children`.
    const files = {
      '/App.svelte': `<script>\n  import Box from './Box.svelte';\n</script>\n<Box />\n`,
      '/Box.svelte':
        `<script>\n  let { loading = false, children } = $props();\n</script>\n` +
        `<div>{#if loading}<span>L</span>{/if}{@render children?.()}</div>\n`,
    };
    const { resolve, readFile } = memGraph(files);
    const { plans } = await analyze('/App.svelte', resolve, readFile);
    expect(plans.get('/Box.svelte')!.constFold.get('loading')).toBe(false);
    // No body -> `children` falls back to its default (undefined) -> foldable.
    expect(plans.get('/Box.svelte')!.constFold.has('children')).toBe(true);
    const out = await svelteShaker('/App.svelte', resolve, readFile);
    assertCompiles(out['/Box.svelte']!, 'Box.svelte');
  });

  it('a snippet passed as a dynamic ATTRIBUTE is correctly kept (already sound)', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Box from './Box.svelte';\n</script>\n` +
        `{#snippet foo()}<i>x</i>{/snippet}\n<Box children={foo} />\n`,
      '/Box.svelte':
        `<script>\n  let { children } = $props();\n</script>\n` +
        `<div>{@render children?.()}</div>\n`,
    };
    const { resolve, readFile } = memGraph(files);
    const { plans } = await analyze('/App.svelte', resolve, readFile);
    expect(plans.get('/Box.svelte')!.constFold.has('children')).toBe(false);
    const out = await svelteShaker('/App.svelte', resolve, readFile);
    assertCompiles(out['/Box.svelte']!, 'Box.svelte');
  });
});

// ---- helpers for rendering an App -> child graph through the oracle ---------

/** Compile a `{ id: source }` graph (only `.svelte` entries) and render `entry`. */
async function renderGraph(sources: Record<string, string>, entry: string): Promise<string> {
  mkdirSync(TMP, { recursive: true });
  const hash = createHash('sha1')
    .update(JSON.stringify(Object.entries(sources).sort()))
    .update(entry)
    .digest('hex')
    .slice(0, 16);
  const dir = join(TMP, hash);
  mkdirSync(dir, { recursive: true });
  for (const [id, source] of Object.entries(sources)) {
    if (!id.endsWith('.svelte')) continue;
    const name = id.replace(/^\//, '');
    const { js } = compile(source, {
      generate: 'server',
      filename: name,
      dev: false,
    });
    const rewired = js.code.replace(
      /(['"])(\.\/[^'"]+\.svelte)\1/g,
      (_m, q: string, spec: string) => `${q}${spec}.js${q}`,
    );
    writeFileSync(join(dir, `${name}.js`), rewired);
  }
  const entryName = entry.replace(/^\//, '');
  const mod = await import(pathToFileURL(join(dir, `${entryName}.js`)).href + `?t=${Date.now()}`);
  const out = render(mod.default, { props: {} });
  return (out.body ?? out.html ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function renderApp(files: Record<string, string>, entry: string): Promise<string> {
  return renderGraph(files, entry);
}

function renderAppWith(
  files: Record<string, string>,
  shaken: Record<string, string>,
  entry: string,
): Promise<string> {
  // Merge shaken `.svelte` outputs over the originals; non-svelte files stay.
  const merged: Record<string, string> = { ...files, ...shaken };
  return renderGraph(merged, entry);
}
