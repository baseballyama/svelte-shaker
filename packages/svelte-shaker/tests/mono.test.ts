import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build, type Rollup } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { shaker } from '../src/vite';
import { analyze } from '../src/analyze';
import { monomorphize } from '../src/mono';
import { svelteShakerWithMono, svelteShaker } from '../src/index';
import { assertCompiles, cleanTmp, renderGraphHtml } from './diff';

afterAll(() => cleanTmp());

// ----------------------------------------------------------------------
// L2 per-call-site monomorphization (docs §3 "L2", §11, §13.2).  OPT-IN,
// BAIL-SAFE, and — the property under test — NEVER BLOATING.
//
// L1.5 already removes every arm dead APP-WIDE, so L2 only shrinks the bundle
// when specialization makes a whole MODULE become globally unreferenced — which
// happens for CORRELATED multi-prop conditions L1.5's per-prop narrowing cannot
// kill.  L2 therefore runs a MEASURED net-win gate:
//   (1) ALL-SITES-OR-NOTHING: only specialize a child when every live call site
//       maps to a non-base residual (so the base module becomes unreferenced),
//   (2) measure the whole-program reachable module bytes (compiled client JS) in
//       the BASE vs SPEC scenarios and specialize iff SPEC is strictly smaller.
//
// Soundness is proven by differential SSR: each specialized residual renders the
// SAME observable HTML as the base component for the value occurring at its site;
// declining to specialize (the conservative bail) is also always correct.
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

const ON = { enabled: true, maxVariants: 8, minSavings: 0 } as const;

// ----------------------------------------------------------------------
// THE CORRELATED-CONDITION CASE (the win L2 exists for).
//
// `a`,`b` are app-wide multi-valued (a∈{0,1}, b∈{0,1}), so L1 cannot fold them
// and L1.5 narrows them INDEPENDENTLY — it cannot prove `a === 1 && b === 1` is
// never both true, so it keeps `<Heavy/>`.  The only sites are (0,1) and (1,0),
// never (1,1).  L2 freezes a (or b) per site, the correlated `{#if}` folds false
// in every variant, `<Heavy/>` vanishes from every variant, Heavy is globally
// unreferenced — and the bundle shrinks.
// ----------------------------------------------------------------------

const HEAVY_BODY =
  '<div class="heavy">' +
  Array.from({ length: 40 }, (_, i) => `<span>heavy widget cell ${i}</span>`).join('') +
  '</div>';

const CORRELATED_FILES: Record<string, string> = {
  '/App.svelte':
    `<script>\n  import Child from './Child.svelte';\n</script>\n` +
    `<Child a={0} b={1} />\n<Child a={1} b={0} />\n`,
  '/Child.svelte':
    `<script>\n  import Heavy from './Heavy.svelte';\n  let { a, b } = $props();\n</script>\n` +
    `{#if a === 1 && b === 1}<Heavy />{/if}<p>base</p>\n`,
  '/Heavy.svelte': `<script>\n  let { n = 0 } = $props();\n</script>\n${HEAVY_BODY}\n`,
};

describe('L2 monomorphize / off-by-default + byte-identical (the contract)', () => {
  it('OFF by default: no variants, no bindings, base output byte-identical', async () => {
    const { resolve, readFile } = memGraph(CORRELATED_FILES);
    const { models, plans } = await analyze('/App.svelte', resolve, readFile);

    // Default options -> disabled.
    const res = monomorphize(models, plans);
    expect(res.variants.size).toBe(0);
    expect(res.bindings.length).toBe(0);

    // With L2 off, the wired output equals the plain shaker output byte-for-byte.
    const base = await svelteShaker('/App.svelte', resolve, readFile);
    const withMono = await svelteShakerWithMono('/App.svelte', resolve, readFile);
    expect(withMono.files).toEqual(base);
    expect(withMono.mono.variants.size).toBe(0);
  });
});

describe('L2 monomorphize / correlated condition (C IS specialized, Heavy removed)', () => {
  it('L1/L1.5 keep `<Heavy/>`: the correlated `{#if}` cannot be narrowed away', async () => {
    const { resolve, readFile } = memGraph(CORRELATED_FILES);
    const { plans } = await analyze('/App.svelte', resolve, readFile);
    const childPlan = plans.get('/Child.svelte')!;
    // a and b are multi-valued -> narrowed, not folded.
    expect(childPlan.constFold.has('a')).toBe(false);
    expect(childPlan.constFold.has('b')).toBe(false);
    expect([...(childPlan.narrow.get('a') ?? [])].sort()).toEqual([0, 1]);
    expect([...(childPlan.narrow.get('b') ?? [])].sort()).toEqual([0, 1]);

    // The base-shaken Child STILL renders `<Heavy/>` (L1.5 cannot kill it).
    const base = await svelteShaker('/App.svelte', resolve, readFile);
    expect(base['/Child.svelte']).toContain('<Heavy');
  });

  it('L2 specializes Child: every variant drops `<Heavy/>` (net win)', async () => {
    const { resolve, readFile } = memGraph(CORRELATED_FILES);
    const { models, plans } = await analyze('/App.svelte', resolve, readFile);
    const res = monomorphize(models, plans, ON, '/App.svelte');

    // Both live Child sites are specialized (all-sites-or-nothing satisfied).
    expect(res.bindings.length).toBe(2);
    expect(res.bindings.every((b) => b.childId === '/Child.svelte')).toBe(true);

    // No variant renders `<Heavy/>` (the correlated branch folded false in each).
    for (const v of res.variants.values()) {
      expect(v.code).not.toContain('<Heavy');
      expect(v.code).not.toMatch(/\{#if/);
      assertCompiles(v.code, 'Child.svelte');
    }
  });

  it('soundness: each variant renders identically to base Child for its (a,b)', async () => {
    const { resolve, readFile } = memGraph(CORRELATED_FILES);
    const { models, plans } = await analyze('/App.svelte', resolve, readFile);
    const res = monomorphize(models, plans, ON, '/App.svelte');

    const deps = { './Heavy.svelte': CORRELATED_FILES['/Heavy.svelte']! };
    for (const b of res.bindings) {
      const a = b.foldedProps.get('a');
      const bb = b.foldedProps.get('b');
      const variant = res.variants.get(b.variantId)!;
      const before = await renderGraphHtml(
        {
          specifier: './Child.svelte',
          source: CORRELATED_FILES['/Child.svelte']!,
        },
        deps,
        { a, b: bb },
      );
      const after = await renderGraphHtml(
        { specifier: './Child.svelte', source: variant.code },
        deps,
        {},
      );
      expect(after, `a=${a} b=${bb}`).toBe(before);
    }
  });

  it('plain inline variants with no module elimination DECLINE (gate guards bloat)', async () => {
    // A plain `variant ∈ {primary, secondary, danger}`: three DISTINCT residual
    // shapes, each duplicating a large shared base.  No child module is
    // eliminated, so splitting into three per-shape modules just triplicates the
    // shared scaffolding -> the gate must DECLINE (and the output equals L1.5).
    const shared = `<section>${Array.from({ length: 30 }, (_, i) => `<p class="row">shared base content line ${i}</p>`).join('')}</section>`;
    const files = {
      '/App.svelte':
        `<script>\n  import Btn from './Btn.svelte';\n</script>\n` +
        `<Btn variant="primary" />\n<Btn variant="secondary" />\n<Btn variant="danger" />\n`,
      '/Btn.svelte':
        `<script>\n  let { variant } = $props();\n</script>\n` +
        `${shared}\n` +
        `{#if variant === 'danger'}<strong>D</strong>{:else if variant === 'primary'}<b>P</b>{:else}<i>S</i>{/if}\n`,
    };
    const { resolve, readFile } = memGraph(files);
    const { models, plans } = await analyze('/App.svelte', resolve, readFile);

    // L1.5 cannot remove any arm app-wide (all three values occur).
    expect([...(plans.get('/Btn.svelte')!.narrow.get('variant') ?? [])].sort()).toEqual([
      'danger',
      'primary',
      'secondary',
    ]);

    const res = monomorphize(models, plans, ON, '/App.svelte');
    expect(res.variants.size).toBe(0); // declined: specializing would bloat
    expect(res.bindings.length).toBe(0);

    // And the wired output is byte-identical to the plain L1.5 shake.
    const base = await svelteShaker('/App.svelte', resolve, readFile);
    const withMono = await svelteShakerWithMono('/App.svelte', resolve, readFile, ON, (id) => id);
    expect(withMono.files).toEqual(base);
  });
});

describe('L2 monomorphize / all-sites-or-nothing gate', () => {
  it('a single live site keeping the base disqualifies the whole child', async () => {
    // Two Child sites: one correlated-foldable, one fully dynamic (`a={x} b={y}`)
    // that folds NOTHING and keeps the base.  Because the base module can never
    // be orphaned, we must NOT specialize (otherwise base + variant = bloat).
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n  let x = 1, y = 1;\n</script>\n` +
        `<Child a={0} b={1} />\n<Child a={x} b={y} />\n`,
      '/Child.svelte': CORRELATED_FILES['/Child.svelte']!,
      '/Heavy.svelte': CORRELATED_FILES['/Heavy.svelte']!,
    };
    const { resolve, readFile } = memGraph(files);
    const { models, plans } = await analyze('/App.svelte', resolve, readFile);
    const res = monomorphize(models, plans, ON, '/App.svelte');
    expect(res.variants.size).toBe(0);
    expect(res.bindings.length).toBe(0);
  });

  it('maxVariants exceeded => child keeps the base entirely (no partial split)', async () => {
    // Three distinct shapes but a cap of 2: we cannot give every live site a
    // variant, so the base would stay referenced -> specialize NONE of them.
    const files = {
      '/App.svelte':
        `<script>\n  import Btn from './Btn.svelte';\n</script>\n` +
        `<Btn variant="primary" />\n<Btn variant="secondary" />\n<Btn variant="danger" />\n`,
      '/Btn.svelte':
        `<script>\n  import Heavy from './Heavy.svelte';\n  let { variant } = $props();\n</script>\n` +
        `{#if variant === 'danger'}<Heavy />{/if}<b>{variant}</b>\n`,
      '/Heavy.svelte': CORRELATED_FILES['/Heavy.svelte']!,
    };
    const { resolve, readFile } = memGraph(files);
    const { models, plans } = await analyze('/App.svelte', resolve, readFile);
    const res = monomorphize(models, plans, { ...ON, maxVariants: 2 });
    expect(res.variants.size).toBe(0);
    expect(res.bindings.length).toBe(0);
  });

  it('nested specialization is declined (a candidate owner of a candidate child)', async () => {
    // App -> Mid -> Leaf, where BOTH Mid and Leaf would specialize all-sites.
    // If we specialized Leaf, Mid's variant residual would still render BASE Leaf
    // (the variant is not re-wired), so Leaf's base stays referenced AND Leaf's
    // variants are emitted = bloat.  The guard must decline Leaf (Mid may still
    // specialize); declining is the conservative never-bloat choice.
    const files = {
      '/App.svelte':
        `<script>\n  import Mid from './Mid.svelte';\n</script>\n` +
        `<Mid a={0} b={1} />\n<Mid a={1} b={0} />\n`,
      '/Mid.svelte':
        `<script>\n  import Heavy from './Heavy.svelte';\n  import Leaf from './Leaf.svelte';\n  let { a, b } = $props();\n</script>\n` +
        `{#if a === 1 && b === 1}<Heavy />{/if}<Leaf a={a} b={b} />\n`,
      '/Leaf.svelte':
        `<script>\n  import Heavy from './Heavy.svelte';\n  let { a, b } = $props();\n</script>\n` +
        `{#if a === 1 && b === 1}<Heavy />{/if}<p>leaf</p>\n`,
      '/Heavy.svelte': CORRELATED_FILES['/Heavy.svelte']!,
    };
    const { resolve, readFile } = memGraph(files);
    const { models, plans } = await analyze('/App.svelte', resolve, readFile);
    const res = monomorphize(models, plans, ON, '/App.svelte');
    // Leaf is never specialized (its owner Mid is a candidate).
    expect([...res.variants.values()].some((v) => v.childId === '/Leaf.svelte')).toBe(false);
    expect(res.bindings.some((b) => b.childId === '/Leaf.svelte')).toBe(false);
  });
});

describe('L2 monomorphize / bail-safety (soundness over aggressiveness)', () => {
  it('a fully-bailed child (escape) is never specialized', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import D from './D.svelte';\n</script>\n` +
        `<D a={0} b={1} />\n<svelte:component this={D} a={1} b={0} />\n`,
      '/D.svelte': CORRELATED_FILES['/Child.svelte']!.replace('./Heavy.svelte', './Heavy.svelte'),
      '/Heavy.svelte': CORRELATED_FILES['/Heavy.svelte']!,
    };
    const { resolve, readFile } = memGraph(files);
    const { models, plans } = await analyze('/App.svelte', resolve, readFile);
    expect(plans.get('/D.svelte')!.bail).toBe(true);
    const res = monomorphize(models, plans, ON, '/App.svelte');
    expect(res.variants.size).toBe(0); // escaped child -> no specialization
  });

  it('a prop shadowed by an `{#each as}` binding is never frozen', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n</script>\n` +
        `<Child item={false} items={['a', 'b']} />\n` +
        `<Child item={true} items={['c']} />\n`,
      '/Child.svelte':
        `<script>\n  let { item = false, items = [] } = $props();\n</script>\n` +
        `<ul>{#each items as item}{#if item}<li>{item}</li>{/if}{/each}</ul>\n`,
    };
    const { resolve, readFile } = memGraph(files);
    const { models, plans } = await analyze('/App.svelte', resolve, readFile);
    const res = monomorphize(models, plans, ON, '/App.svelte');
    for (const v of res.variants.values()) expect(v.foldedProps.has('item')).toBe(false);
  });

  it('a call site inside a DEAD `{#if}` span is never specialized', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Mid from './Mid.svelte';\n</script>\n` + `<Mid show={false} />\n`,
      '/Mid.svelte':
        `<script>\n  import Btn from './Btn.svelte';\n  let { show } = $props();\n</script>\n` +
        `{#if show}<Btn variant="danger" />{/if}<p>mid</p>\n`,
      '/Btn.svelte':
        `<script>\n  let { variant = 'x' } = $props();\n</script>\n` +
        `{#if variant === 'danger'}<strong>D</strong>{:else}<i>o</i>{/if}\n`,
    };
    const { resolve, readFile } = memGraph(files);
    const { models, plans } = await analyze('/App.svelte', resolve, readFile);
    const res = monomorphize(models, plans, ON, '/App.svelte');
    const btnVariants = [...res.variants.values()].filter((v) => v.childId === '/Btn.svelte');
    expect(btnVariants.length).toBe(0);
  });

  it('rest forwarding survives a specialized site (and renders identically)', async () => {
    // App-wide a∈{0,1}, b∈{0,1}, only (0,1)/(1,0): correlated, so the child IS
    // specialized; the `{...spread}` must still be forwarded by the variant.
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n  let extra = { id: 'X' };\n</script>\n` +
        `<Child {...extra} a={0} b={1} />\n<Child {...extra} a={1} b={0} />\n`,
      '/Child.svelte':
        `<script>\n  import Heavy from './Heavy.svelte';\n  let { a, b, ...rest } = $props();\n</script>\n` +
        `<div {...rest}>{#if a === 1 && b === 1}<Heavy />{/if}base</div>\n`,
      '/Heavy.svelte': CORRELATED_FILES['/Heavy.svelte']!,
    };
    const { resolve, readFile } = memGraph(files);
    const res = await svelteShakerWithMono('/App.svelte', resolve, readFile, ON, (id) => id);
    const variant = [...res.mono.variants.values()][0]!;
    expect(variant.code).toContain('{...rest}'); // rest still forwarded
    expect(variant.code).not.toContain('<Heavy');
    assertCompiles(variant.code, 'Child.svelte');

    // Differential SSR: variant + forwarded rest renders identically to base.
    const deps = { './Heavy.svelte': files['/Heavy.svelte']! };
    const before = await renderGraphHtml(
      { specifier: './Child.svelte', source: files['/Child.svelte']! },
      deps,
      { a: 0, b: 1, id: 'X' },
    );
    const after = await renderGraphHtml(
      { specifier: './Child.svelte', source: variant.code },
      deps,
      { id: 'X' },
    );
    expect(after).toBe(before);
    expect(before).toBe('<div id="X">base</div>');
  });
});

// ----------------------------------------------------------------------
// End-to-end Vite build: L2 wires the variants to real (virtual) modules and the
// net-win gate orphans Heavy.  The control build (no shaker) keeps the shared
// `Child` conditional AND bundles Heavy; the L2 build specializes both call sites
// so the conditional is gone and Heavy is dropped from the bundle.  This is the
// rollup-can't proof: rollup cannot specialize a component per call site, so it
// keeps the correlated `{#if}` and therefore keeps Heavy.
// ----------------------------------------------------------------------

const VITE_APP = join(dirname(fileURLToPath(import.meta.url)), '.shaker-tmp-mono');

const HEAVY_MARK = 'HEAVY_WIDGET_MARKER';
const VITE_FILES: Record<string, string> = {
  'main.ts': `import { mount } from 'svelte';\nimport App from './App.svelte';\nmount(App, { target: document.body });\n`,
  'App.svelte': `<script lang="ts">\n  import Child from './Child.svelte';\n</script>\n<Child a={0} b={1} />\n<Child a={1} b={0} />\n`,
  'Child.svelte': `<script lang="ts">\n  import Heavy from './Heavy.svelte';\n  let { a, b }: { a: number; b: number } = $props();\n</script>\n{#if a === 1 && b === 1}<Heavy />{/if}<p>base</p>\n`,
  'Heavy.svelte': `<script lang="ts">\n</script>\n<div>${HEAVY_MARK}</div>\n`,
};

const IF_MACHINERY = /\bif_block\b|\$\.if\(/;

beforeAll(() => {
  rmSync(VITE_APP, { recursive: true, force: true });
  mkdirSync(VITE_APP, { recursive: true });
  for (const [name, content] of Object.entries(VITE_FILES))
    writeFileSync(join(VITE_APP, name), content);
});

afterAll(() => rmSync(VITE_APP, { recursive: true, force: true }));

async function bundle(pre: unknown[]): Promise<string> {
  const result = (await build({
    root: VITE_APP,
    logLevel: 'silent',
    configFile: false,
    build: {
      write: false,
      minify: false,
      reportCompressedSize: false,
      target: 'esnext',
      rollupOptions: { input: join(VITE_APP, 'main.ts') },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    plugins: [...pre, svelte({ compilerOptions: { runes: true } })] as any,
  })) as Rollup.RollupOutput;
  return result.output.map((c) => ('code' in c ? c.code : '')).join('\n');
}

describe('vite-plugin-svelte-shaker / L2 (end-to-end build)', () => {
  it('control: the correlated `{#if}` survives and Heavy is bundled', async () => {
    const code = await bundle([]);
    expect(code).toMatch(IF_MACHINERY);
    expect(code).toContain(HEAVY_MARK);
  });

  it('level 1: L2 is OFF, the conditional and Heavy both survive', async () => {
    const code = await bundle([shaker({ include: ['.'], level: 1 })]);
    expect(code).toMatch(IF_MACHINERY);
    expect(code).toContain(HEAVY_MARK);
  });

  it('default (no level): L2 is ON -> correlated `{#if}` gone AND Heavy dropped', async () => {
    const code = await bundle([shaker({ include: ['.'] })]);
    // L2 is on by default now: the correlated branch folds false in every variant
    // -> no conditional, and `<Heavy/>` is orphaned and dropped from the bundle.
    expect(code).not.toMatch(IF_MACHINERY);
    expect(code).not.toContain(HEAVY_MARK);
    expect(code).toContain('base');
  });

  it('level 2 (explicit): correlated sites specialized -> `{#if}` gone AND Heavy dropped', async () => {
    const code = await bundle([shaker({ include: ['.'], level: 2, monomorphize: true })]);
    // The correlated branch folded false in every variant -> no conditional.
    expect(code).not.toMatch(IF_MACHINERY);
    // ... and `<Heavy/>` is gone from every variant -> Heavy is unreferenced ->
    // the bundler drops it entirely.  THAT is the L2 win.
    expect(code).not.toContain(HEAVY_MARK);
    // The base content still renders.
    expect(code).toContain('base');
  });

  it('level 2 bundle is <= the level-1 (L1.5) bundle in bytes (never bloat)', async () => {
    const l1 = await bundle([shaker({ include: ['.'], level: 1 })]);
    const l2 = await bundle([shaker({ include: ['.'], level: 2, monomorphize: true })]);
    expect(l2.length).toBeLessThanOrEqual(l1.length);
  });
});
