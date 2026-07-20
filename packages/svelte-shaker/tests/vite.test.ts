import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build, type Rollup } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { shaker, type ShakerOptions } from '../src/vite';

// Build inside the package so the temp app resolves `svelte/internal/*`.
const APP = join(dirname(fileURLToPath(import.meta.url)), '.shaker-tmp-vite');

const FILES: Record<string, string> = {
  'main.ts': `import { mount } from 'svelte';\nimport App from './App.svelte';\nmount(App, { target: document.body });\n`,
  'App.svelte': `<script lang="ts">\n  import Sub from './Sub.svelte';\n</script>\n\n<Sub hasIcon={false} />\n`,
  'Sub.svelte': `<script lang="ts">\n  let { hasIcon }: { hasIcon: boolean } = $props();\n</script>\n\n{#if hasIcon}\n  <p>Icon</p>\n{/if}\n\n<p>This is Sub Component</p>\n`,
};

/** Conditional-rendering machinery Svelte emits for a surviving `{#if}`. */
const IF_MACHINERY = /\bif_block\b|\$\.if\(/;

beforeAll(() => {
  rmSync(APP, { recursive: true, force: true });
  mkdirSync(APP, { recursive: true });
  for (const [name, content] of Object.entries(FILES)) writeFileSync(join(APP, name), content);
});

afterAll(() => rmSync(APP, { recursive: true, force: true }));

async function bundle(
  pre: unknown[],
  opts: { sourcemap?: boolean; onwarn?: (warning: Rollup.RollupLog) => void } = {},
): Promise<string> {
  const result = (await build({
    root: APP,
    logLevel: 'silent',
    configFile: false,
    build: {
      write: false,
      minify: false,
      sourcemap: opts.sourcemap ?? false,
      reportCompressedSize: false,
      target: 'esnext',
      rollupOptions: {
        input: join(APP, 'main.ts'),
        ...(opts.onwarn ? { onwarn: opts.onwarn } : {}),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    plugins: [...pre, svelte({ compilerOptions: { runes: true } })] as any,
  })) as Rollup.RollupOutput;
  return result.output.map((c) => ('code' in c ? c.code : '')).join('\n');
}

describe('vite-plugin-svelte-shaker (end-to-end build)', () => {
  it('control: Svelte still compiles the dead `{#if}` into conditional machinery', async () => {
    const code = await bundle([]);
    expect(code).toMatch(IF_MACHINERY);
    expect(code).toContain('This is Sub Component');
  });

  it('shaker: the dead branch is removed at source, so no conditional is compiled', async () => {
    const code = await bundle([shaker({ entries: ['.'] })]);
    expect(code).not.toMatch(IF_MACHINERY);
    expect(code).toContain('This is Sub Component'); // live markup survives
  });

  it('engine: the native Rust engine shakes identically to the JS engine', async () => {
    const js = await bundle([shaker({ entries: ['.'], monomorphize: false, engine: 'js' })]);
    const rust = await bundle([shaker({ entries: ['.'], monomorphize: false, engine: 'rust' })]);
    // The Rust engine removed the dead branch just like the JS engine …
    expect(rust).not.toMatch(IF_MACHINERY);
    expect(rust).toContain('This is Sub Component');
    // … and the whole bundle is byte-identical (the engines are differential-tested).
    expect(rust).toBe(js);
  });

  it('sourcemap: a shaken file reports an empty map, so no SOURCEMAP_BROKEN warning', async () => {
    // Issue #89: replacing a component's source in `transform` without declaring a
    // sourcemap makes Rollup/Rolldown warn the map is likely wrong. The shaker
    // returns `{ mappings: '' }` for shaken files, which is the sanctioned "no map
    // available" signal, so the warning must not fire when sourcemaps are on.
    const warnings: string[] = [];
    await bundle([shaker({ entries: ['.'] })], {
      sourcemap: true,
      onwarn: (warning) => warnings.push(warning.code ?? warning.message),
    });
    expect(warnings).not.toContain('SOURCEMAP_BROKEN');
  });

  it('the removed `include` option throws instead of being silently ignored', () => {
    // `include` is gone from `ShakerOptions`, so a stale config only reaches us at
    // runtime (a JS config, or a copy-pasted snippet). Ignoring it would fall back
    // to the Vite root — sound, but the user's roots would silently not apply.
    // Typing the stale key back on is what lets this compile at all, so the test
    // exercises the runtime guard rather than a type error.
    const staleConfig: ShakerOptions & { include: string[] } = { include: ['.'] };
    expect(() => shaker(staleConfig)).toThrow(/"include" option was renamed to "entries"/);
  });

  it('engine: "rust" shakes with monomorphization on by default (native)', async () => {
    // The Rust engine implements monomorphization too, so engine: "rust" with the
    // default options shakes the dead branch (and would specialize where it wins)
    // rather than throw.
    const code = await bundle([shaker({ entries: ['.'], engine: 'rust' })]);
    expect(code).not.toMatch(IF_MACHINERY);
    expect(code).toContain('This is Sub Component');
  });
});
