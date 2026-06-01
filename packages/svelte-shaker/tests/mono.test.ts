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
import { assertCompiles, cleanTmp, renderHtml } from './diff';

afterAll(() => cleanTmp());

// ----------------------------------------------------------------------
// L2 per-call-site monomorphization (docs §3 "L2", §13.2).  OPT-IN and
// BAIL-SAFE.  The headline differentiator: a prop that is app-wide multi-valued
// (so L1 cannot fold it and L1.5 cannot remove ANY arm, because every value is
// reachable somewhere) is frozen PER CALL SITE, so a specific
// `<Btn variant="primary"/>` gets a copy whose every non-primary branch is gone.
//
// Soundness is proven by differential SSR: each specialized residual renders the
// SAME observable HTML as the base component for the value that occurs at the
// site it was made for.  "Sound" is also satisfied by leaving a site
// un-specialized (a conservative bail) — every test that bails still renders
// correctly because the base output is always correct.
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

const ON = { enabled: true, maxVariants: 8 } as const;

// A `variant` that is {primary, secondary, danger} app-wide: L1 cannot fold it
// and L1.5 cannot remove any arm — every value occurs at SOME site.
const VARIANT_FILES: Record<string, string> = {
  '/App.svelte':
    `<script>\n  import Btn from './Btn.svelte';\n</script>\n` +
    `<Btn variant="primary" />\n<Btn variant="secondary" />\n<Btn variant="danger" />\n`,
  '/Btn.svelte':
    `<script>\n  let { variant } = $props();\n</script>\n` +
    `{#if variant === 'danger'}<strong>DANGER</strong>` +
    `{:else if variant === 'primary'}<b>P</b>` +
    `{:else if variant === 'secondary'}<i>S</i>` +
    `{:else}<u>O</u>{/if}\n`,
};

describe('L2 monomorphize / engine (the differentiator)', () => {
  it('OFF by default: no variants, no bindings, base output unchanged', async () => {
    const { resolve, readFile } = memGraph(VARIANT_FILES);
    const { models, plans } = await analyze('/App.svelte', resolve, readFile);

    // Default options -> disabled.
    const res = monomorphize(models, plans);
    expect(res.variants.size).toBe(0);
    expect(res.bindings.length).toBe(0);

    // With L2 off, the wired output equals the plain shaker output byte-for-byte.
    const base = await svelteShaker('/App.svelte', resolve, readFile);
    const withMono = await svelteShakerWithMono(
      '/App.svelte',
      resolve,
      readFile,
    );
    expect(withMono.files).toEqual(base);
    expect(withMono.mono.variants.size).toBe(0);
  });

  it('removes an arm L1/L1.5 CANNOT: each literal site gets a single-arm residual', async () => {
    const { resolve, readFile } = memGraph(VARIANT_FILES);
    const { models, plans } = await analyze('/App.svelte', resolve, readFile);

    // Baseline: L1 does NOT fold `variant` (multi-valued) and L1.5 narrows it to
    // the full {primary,secondary,danger} set, so NO arm is removable app-wide.
    const plan = plans.get('/Btn.svelte')!;
    expect(plan.constFold.has('variant')).toBe(false);
    expect([...(plan.narrow.get('variant') ?? [])].sort()).toEqual([
      'danger',
      'primary',
      'secondary',
    ]);

    // L2 specializes each of the three literal sites.
    const res = monomorphize(models, plans, ON);
    expect(res.variants.size).toBe(3);
    expect(res.bindings.length).toBe(3);

    // Each residual contains exactly ONE arm's content and no `{#if}` at all.
    for (const v of res.variants.values()) {
      expect(v.code).not.toMatch(/\{#if/);
      expect(v.code).not.toMatch(/\{:else/);
      assertCompiles(v.code, 'Btn.svelte');
    }
    const bodies = [...res.variants.values()].map((v) => v.code);
    expect(bodies.some((c) => c.includes('DANGER'))).toBe(true);
    expect(bodies.some((c) => c.includes('<b>P</b>'))).toBe(true);
    expect(bodies.some((c) => c.includes('<i>S</i>'))).toBe(true);
  });

  it('soundness: every variant renders identically to the base for its value', async () => {
    const { resolve, readFile } = memGraph(VARIANT_FILES);
    const { models, plans } = await analyze('/App.svelte', resolve, readFile);
    const res = monomorphize(models, plans, ON);
    const original = VARIANT_FILES['/Btn.svelte']!;

    for (const v of res.variants.values()) {
      const variant = v.foldedProps.get('variant');
      const before = await renderHtml(original, { variant }, 'Btn.svelte');
      const after = await renderHtml(v.code, {}, 'Btn.svelte'); // frozen -> no props
      expect(after, String(variant)).toBe(before);
    }
  });

  it('dedup by residual: two identical-shape sites share ONE variant', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Btn from './Btn.svelte';\n</script>\n` +
        `<Btn variant="primary" />\n<Btn variant="primary" />\n<Btn variant="secondary" />\n`,
      '/Btn.svelte': VARIANT_FILES['/Btn.svelte']!,
    };
    const { resolve, readFile } = memGraph(files);
    const { models, plans } = await analyze('/App.svelte', resolve, readFile);
    const res = monomorphize(models, plans, ON);
    // 3 sites, but the two `primary` sites dedup -> 2 variants, 3 bindings.
    expect(res.variants.size).toBe(2);
    expect(res.bindings.length).toBe(3);
    const ids = res.bindings.map((b) => b.variantId);
    expect(ids[0]).toBe(ids[1]); // both primary sites -> same variant id
    expect(ids[2]).not.toBe(ids[0]);
  });

  it('maxVariants cap: surplus distinct shapes fall back to the base component', async () => {
    const { resolve, readFile } = memGraph(VARIANT_FILES);
    const { models, plans } = await analyze('/App.svelte', resolve, readFile);
    const res = monomorphize(models, plans, { enabled: true, maxVariants: 2 });
    // Only 2 of the 3 distinct shapes get a variant; the 3rd keeps the base.
    expect(res.variants.size).toBe(2);
    expect(res.bindings.length).toBe(2);
  });
});

describe('L2 monomorphize / bail-safety (soundness over aggressiveness)', () => {
  it('a dynamic call-site value is NOT specialized (only literal sites are)', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Btn from './Btn.svelte';\n  let v = 'primary';\n</script>\n` +
        `<Btn variant={v} />\n<Btn variant="danger" />\n`,
      '/Btn.svelte':
        `<script>\n  let { variant } = $props();\n</script>\n` +
        `{#if variant === 'danger'}<strong>D</strong>{:else}<i>o</i>{/if}\n`,
    };
    const { resolve, readFile } = memGraph(files);
    const { models, plans } = await analyze('/App.svelte', resolve, readFile);
    const res = monomorphize(models, plans, ON);
    // The `variant={v}` site cannot be specialized; only `variant="danger"` is.
    expect(res.bindings.length).toBe(1);
    expect(res.bindings[0]!.foldedProps.get('variant')).toBe('danger');
  });

  it('a fully-bailed child (escape) is never specialized', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import D from './D.svelte';\n</script>\n` +
        `<D variant="primary" />\n<svelte:component this={D} variant="danger" />\n`,
      '/D.svelte':
        `<script>\n  let { variant } = $props();\n</script>\n` +
        `{#if variant === 'danger'}<strong>D</strong>{:else}<i>o</i>{/if}\n`,
    };
    const { resolve, readFile } = memGraph(files);
    const { models, plans } = await analyze('/App.svelte', resolve, readFile);
    expect(plans.get('/D.svelte')!.bail).toBe(true);
    const res = monomorphize(models, plans, ON);
    expect(res.variants.size).toBe(0); // escaped child -> no specialization
  });

  it('a prop shadowed by an `{#each as}` binding is never frozen', async () => {
    // `item` is a prop AND the loop binding. Freezing it would rewrite `as item`
    // and delete the wrong arm. The analysis already refuses to fold it; L2 must
    // too. (No other foldable prop here -> no variant at all.)
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
    const res = monomorphize(models, plans, ON);
    for (const v of res.variants.values())
      expect(v.foldedProps.has('item')).toBe(false);
  });

  it('a call site inside a DEAD `{#if}` span is never specialized', async () => {
    // `<Mid show={false}/>` folds Mid's `{#if show}` block, which CONTAINS the
    // only `<Btn variant="danger"/>` site. That dead site must NOT drive a
    // variant (it disappears from the output).
    const files = {
      '/App.svelte':
        `<script>\n  import Mid from './Mid.svelte';\n</script>\n` +
        `<Mid show={false} />\n`,
      '/Mid.svelte':
        `<script>\n  import Btn from './Btn.svelte';\n  let { show } = $props();\n</script>\n` +
        `{#if show}<Btn variant="danger" />{/if}<p>mid</p>\n`,
      '/Btn.svelte':
        `<script>\n  let { variant = 'x' } = $props();\n</script>\n` +
        `{#if variant === 'danger'}<strong>D</strong>{:else}<i>o</i>{/if}\n`,
    };
    const { resolve, readFile } = memGraph(files);
    const { models, plans } = await analyze('/App.svelte', resolve, readFile);
    const res = monomorphize(models, plans, ON);
    // The only Btn site is in a dead span -> no variant for Btn.
    const btnVariants = [...res.variants.values()].filter(
      (v) => v.childId === '/Btn.svelte',
    );
    expect(btnVariants.length).toBe(0);
  });

  it('rest forwarding survives: a specialized site keeps its `{...spread}`', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Btn from './Btn.svelte';\n  let extra = { id: 'X' };\n</script>\n` +
        `<Btn {...extra} variant="danger" />\n<Btn variant="primary" />\n`,
      '/Btn.svelte':
        `<script>\n  let { variant = 'x', ...rest } = $props();\n</script>\n` +
        `<div {...rest}>{#if variant === 'danger'}D{:else if variant === 'primary'}P{:else}o{/if}</div>\n`,
    };
    const { resolve, readFile } = memGraph(files);
    const res = await svelteShakerWithMono(
      '/App.svelte',
      resolve,
      readFile,
      ON,
      (id) => id,
    );
    const danger = [...res.mono.variants.values()].find(
      (v) => v.foldedProps.get('variant') === 'danger',
    )!;
    expect(danger.code).toContain('{...rest}'); // rest still forwarded
    assertCompiles(danger.code, 'Btn.svelte');

    // Differential SSR: the danger residual + forwarded rest renders identically
    // to the base Btn(variant=danger, id=X).
    const before = await renderHtml(
      files['/Btn.svelte']!,
      { variant: 'danger', id: 'X' },
      'Btn.svelte',
    );
    const after = await renderHtml(danger.code, { id: 'X' }, 'Btn.svelte');
    expect(after).toBe(before);
    expect(before).toBe('<div id="X">D</div>');
  });

  it('CSS narrows further per variant: a frozen variant drops more rules', async () => {
    // App-wide variant ∈ {primary, danger}: L1.5 keeps both `.btn-primary` and
    // `.btn-danger`. The `variant="primary"` variant freezes it, so `.btn-danger`
    // becomes provably dead in THAT residual and is removed.
    const files = {
      '/App.svelte':
        `<script>\n  import Btn from './Btn.svelte';\n</script>\n` +
        `<Btn variant="primary" />\n<Btn variant="danger" />\n`,
      '/Btn.svelte':
        `<script>\n  let { variant } = $props();\n</script>\n` +
        `<button class="btn btn-{variant}">{variant}</button>\n` +
        `<style>\n  .btn-primary { color: green }\n  .btn-danger { color: red }\n</style>\n`,
    };
    const { resolve, readFile } = memGraph(files);
    const { models, plans } = await analyze('/App.svelte', resolve, readFile);
    const res = monomorphize(models, plans, ON);
    const primary = [...res.variants.values()].find(
      (v) => v.foldedProps.get('variant') === 'primary',
    )!;
    expect(primary.code).toContain('.btn-primary');
    expect(primary.code).not.toContain('.btn-danger'); // unreachable in this variant
    assertCompiles(primary.code, 'Btn.svelte');
  });
});

// ----------------------------------------------------------------------
// End-to-end Vite build: L2 wires the variants to real (virtual) modules.  The
// control build (no shaker) compiles the shared `Btn` into conditional `{#if}`
// machinery; the L2 build specializes each call site so NO conditional survives,
// yet every occurring label still renders.  This is the rollup-can't proof for
// L2 (rollup cannot specialize a component per call site).
// ----------------------------------------------------------------------

const VITE_APP = join(
  dirname(fileURLToPath(import.meta.url)),
  '.shaker-tmp-mono',
);

const VITE_FILES: Record<string, string> = {
  'main.ts': `import { mount } from 'svelte';\nimport App from './App.svelte';\nmount(App, { target: document.body });\n`,
  'App.svelte': `<script lang="ts">\n  import Btn from './Btn.svelte';\n</script>\n<Btn variant="primary" />\n<Btn variant="secondary" />\n<Btn variant="danger" />\n`,
  'Btn.svelte': `<script lang="ts">\n  let { variant }: { variant: 'primary' | 'secondary' | 'danger' } = $props();\n</script>\n{#if variant === 'danger'}<strong>DANGER</strong>{:else if variant === 'primary'}<b>PRIMARY</b>{:else}<i>SECONDARY</i>{/if}\n`,
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
  it('control: the shared Btn compiles into conditional `{#if}` machinery', async () => {
    const code = await bundle([]);
    expect(code).toMatch(IF_MACHINERY);
  });

  it('level 1 (default): L2 is OFF, the conditional survives', async () => {
    // Opt-in guard: without `level: 2 + monomorphize`, nothing specializes.
    const code = await bundle([shaker({ include: ['.'] })]);
    expect(code).toMatch(IF_MACHINERY);
  });

  it('level 2: every call site is specialized -> no `{#if}` machinery remains', async () => {
    const code = await bundle([
      shaker({ include: ['.'], level: 2, monomorphize: true }),
    ]);
    // Each variant is straight-line: the conditional is gone entirely.
    expect(code).not.toMatch(IF_MACHINERY);
    // Yet every occurring label still renders (each from its own variant).
    expect(code).toContain('DANGER');
    expect(code).toContain('PRIMARY');
    expect(code).toContain('SECONDARY');
  });
});
