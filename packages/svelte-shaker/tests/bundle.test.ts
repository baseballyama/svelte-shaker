import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build, type Rollup } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { shaker } from '../src/vite';

// ----------------------------------------------------------------------
// REAL Vite build BYTE BENCH — the GROUND TRUTH for monomorphization (docs §3
// "monomorphization", §13.2).
//
// Every other monomorphization test proves PRESENCE/ABSENCE of a marker or the
// engine's gate decision in isolation; this suite measures what actually ships.
// It builds the SAME app three ways and sizes each bundle:
//
//   control    : [svelte()]                                          — no shaking
//   narrowed   : [shaker({ entries:['.'], monomorphize:false }), svelte()] — mono off
//   mono       : [shaker({ entries:['.'] }), svelte()]               — default (mono ON)
//
// total emitted bytes = Σ every output chunk's `code.length`
//                     + Σ every emitted `.css` asset's `source.length`.
//
// THE TWO ABSOLUTE PROPERTIES under test (docs ABSOLUTE RULES #1):
//   * monomorphization must GENUINELY WIN when specialization orphans a heavy
//     module behind a CORRELATED condition value-set narrowing cannot kill
//     (CASE A): bytes(mono) < bytes(narrowed).
//   * monomorphization must NEVER BLOAT: for a plain inline `variant` where no
//     module is eliminated (CASE B) the net-win gate DECLINES, so
//     bytes(mono) == bytes(narrowed).
//   * And shaking never loses to the toolchain: bytes(narrowed) <= bytes(control).
// ----------------------------------------------------------------------

interface Sizes {
  control: number;
  narrowed: number;
  mono: number;
}

/**
 * Total emitted bytes of a build: the sum of every output chunk's compiled
 * `code` length PLUS every emitted `.css` asset's `source` length.  This is the
 * whole shippable payload (JS + extracted CSS), the only honest size proxy.
 */
function totalBytes(out: Rollup.RollupOutput): number {
  let bytes = 0;
  for (const c of out.output) {
    if (c.type === 'chunk') bytes += c.code.length;
    else if (c.fileName.endsWith('.css')) bytes += String(c.source).length;
  }
  return bytes;
}

/** Build `root` with the given pre-plugins and return its total emitted bytes. */
async function buildBytes(root: string, pre: unknown[]): Promise<number> {
  const out = (await build({
    root,
    logLevel: 'silent',
    configFile: false,
    build: {
      write: false,
      minify: false,
      reportCompressedSize: false,
      target: 'esnext',
      rollupOptions: { input: join(root, 'main.ts') },
    },
    // Force production compilation. This bench sizes the SHIPPED bundle; vite 8
    // no longer forces NODE_ENV=production inside build(), so under vitest
    // (NODE_ENV=test) Svelte would otherwise compile in dev mode and inflate the
    // byte counts this suite is the ground truth for.
    plugins: [...pre, svelte({ compilerOptions: { runes: true, dev: false } })] as any,
  })) as Rollup.RollupOutput;
  return totalBytes(out);
}

/** Build the same app three ways (control / narrowed / mono) and size each. */
async function benchAll(root: string): Promise<Sizes> {
  const control = await buildBytes(root, []);
  const narrowed = await buildBytes(root, [shaker({ entries: ['.'], monomorphize: false })]);
  const mono = await buildBytes(root, [shaker({ entries: ['.'] })]);
  return { control, narrowed, mono };
}

function writeApp(root: string, files: Record<string, string>): void {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN =
  `import { mount } from 'svelte';\n` +
  `import App from './App.svelte';\n` +
  `mount(App, { target: document.body });\n`;

// ----------------------------------------------------------------------
// CASE A — monomorphization GENUINELY WINS.
//
// `Child` gates a HEAVY child component behind a CORRELATED multi-prop condition
// `{#if a === 1 && b === 1}<Heavy .../>{/if}`.  App-wide a,b each ∈ {0,1} via the
// only sites (a=0,b=1) and (a=1,b=0) — (1,1) NEVER occurs.  value-set narrowing
// narrows a and b INDEPENDENTLY and cannot prove `a && b` is never both 1, so it
// keeps `<Heavy/>` and Heavy stays in the bundle.  monomorphization freezes a
// (or b) per site -> the correlated `{#if}` folds false in BOTH variants ->
// `<Heavy/>` is gone from every variant -> Heavy is globally unreferenced ->
// the bundler drops it.  THAT is the win.
//
// Heavy is large and distinctive (a big unique string marker) so its removal is
// both measurable in bytes and detectable by marker presence.
// ----------------------------------------------------------------------

const HEAVY_MARK = 'HEAVY_WIDGET_DISTINCTIVE_MARKER';
const HEAVY_BODY =
  `<div class="heavy">` +
  Array.from(
    { length: 80 },
    (_, i) => `<span class="heavy-cell">${HEAVY_MARK} heavy widget cell ${i}</span>`,
  ).join('') +
  `</div>`;

const CASE_A: Record<string, string> = {
  'main.ts': MAIN,
  'App.svelte':
    `<script lang="ts">\n  import Child from './Child.svelte';\n</script>\n` +
    `<Child a={0} b={1} />\n<Child a={1} b={0} />\n`,
  'Child.svelte':
    `<script lang="ts">\n  import Heavy from './Heavy.svelte';\n` +
    `  let { a, b }: { a: number; b: number } = $props();\n</script>\n` +
    `{#if a === 1 && b === 1}<Heavy />{/if}<p>base</p>\n`,
  'Heavy.svelte':
    `<script lang="ts">\n</script>\n${HEAVY_BODY}\n` +
    `<style>\n  .heavy { display: grid }\n  .heavy-cell { color: rebeccapurple }\n</style>\n`,
};

// ----------------------------------------------------------------------
// CASE B — monomorphization must NOT BLOAT.
//
// A plain `variant ∈ {primary, secondary}` with INLINE arms only — no child
// module is eliminated by specializing.  Splitting `Btn` into per-shape modules
// would just duplicate the shared scaffolding and GROW the bundle, so the
// measured net-win gate must DECLINE and the monomorphization output must equal
// the value-set-narrowing output byte-for-byte.
// ----------------------------------------------------------------------

const SHARED = `<section>${Array.from(
  { length: 30 },
  (_, i) => `<p class="row">shared base content line ${i}</p>`,
).join('')}</section>`;

const CASE_B: Record<string, string> = {
  'main.ts': MAIN,
  'App.svelte':
    `<script lang="ts">\n  import Btn from './Btn.svelte';\n</script>\n` +
    `<Btn variant="primary" />\n<Btn variant="secondary" />\n`,
  'Btn.svelte':
    `<script lang="ts">\n` +
    `  let { variant }: { variant: 'primary' | 'secondary' } = $props();\n</script>\n` +
    `${SHARED}\n` +
    `{#if variant === 'primary'}<b>P</b>{:else}<i>S</i>{/if}\n`,
};

describe('vite-plugin-svelte-shaker / monomorphization BYTE BENCH (the ground truth)', () => {
  const APP_A = join(HERE, '.shaker-tmp-bundle-a');
  const APP_B = join(HERE, '.shaker-tmp-bundle-b');

  beforeAll(() => {
    writeApp(APP_A, CASE_A);
    writeApp(APP_B, CASE_B);
  });

  afterAll(() => {
    rmSync(APP_A, { recursive: true, force: true });
    rmSync(APP_B, { recursive: true, force: true });
  });

  it('CASE A: mono wins — correlated condition orphans Heavy, bytes(mono) < bytes(narrowed)', async () => {
    const { control, narrowed, mono } = await benchAll(APP_A);

    console.log(
      `[BUNDLE BENCH / CASE A] control=${control}B  narrowed=${narrowed}B  mono=${mono}B`,
    );

    // Shaking never loses to the toolchain.
    expect(narrowed).toBeLessThanOrEqual(control);

    // The marker is the visible proof Heavy is in/out of the bundle.  value-set
    // narrowing keeps it (cannot kill the correlated `{#if}`); monomorphization
    // drops it (orphaned module).
    const codeNarrowed = await buildCode(APP_A, [shaker({ entries: ['.'], monomorphize: false })]);
    const codeMono = await buildCode(APP_A, [shaker({ entries: ['.'] })]);
    expect(codeNarrowed).toContain(HEAVY_MARK);
    expect(codeMono).not.toContain(HEAVY_MARK);

    // The headline assertion: specialization shrinks the real bundle.
    expect(mono).toBeLessThan(narrowed);

    // Soundness: the app never rendered Heavy anyway (its values never hit the
    // correlated branch), so the visible markup is unchanged — the base text
    // survives both builds and Heavy's markup is in neither.
    expect(codeNarrowed).toContain('base');
    expect(codeMono).toContain('base');
  });

  it('CASE B: mono must not bloat — plain inline variant declines, bytes(mono) == bytes(narrowed)', async () => {
    const { control, narrowed, mono } = await benchAll(APP_B);

    console.log(
      `[BUNDLE BENCH / CASE B] control=${control}B  narrowed=${narrowed}B  mono=${mono}B`,
    );

    // Shaking never loses to the toolchain.
    expect(narrowed).toBeLessThanOrEqual(control);

    // No module is eliminated, so the net-win gate DECLINES to specialize and the
    // monomorphization bundle is byte-identical to the value-set-narrowing bundle
    // — the never-bloat guarantee.
    expect(mono).toBe(narrowed);
    // And, absolutely, monomorphization never exceeds value-set narrowing.
    expect(mono).toBeLessThanOrEqual(narrowed);
  });
});

/** Concatenated JS chunk code of a build (for marker / render assertions). */
async function buildCode(root: string, pre: unknown[]): Promise<string> {
  const out = (await build({
    root,
    logLevel: 'silent',
    configFile: false,
    build: {
      write: false,
      minify: false,
      reportCompressedSize: false,
      target: 'esnext',
      rollupOptions: { input: join(root, 'main.ts') },
    },
    // Force production compilation — see the note in `buildBytes`.
    plugins: [...pre, svelte({ compilerOptions: { runes: true, dev: false } })] as any,
  })) as Rollup.RollupOutput;
  return out.output.map((c) => ('code' in c ? c.code : '')).join('\n');
}
