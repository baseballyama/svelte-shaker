import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build, type Rollup } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { shaker } from '../src/vite';

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

async function bundle(pre: unknown[]): Promise<string> {
  const result = (await build({
    root: APP,
    logLevel: 'silent',
    configFile: false,
    build: {
      write: false,
      minify: false,
      reportCompressedSize: false,
      target: 'esnext',
      rollupOptions: { input: join(APP, 'main.ts') },
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
    const code = await bundle([shaker({ include: ['.'] })]);
    expect(code).not.toMatch(IF_MACHINERY);
    expect(code).toContain('This is Sub Component'); // live markup survives
  });

  it('engine: the native Rust engine shakes identically to the JS engine', async () => {
    const js = await bundle([shaker({ include: ['.'], level: 1, engine: 'js' })]);
    const rust = await bundle([shaker({ include: ['.'], level: 1, engine: 'rust' })]);
    // The Rust engine removed the dead branch just like the JS engine …
    expect(rust).not.toMatch(IF_MACHINERY);
    expect(rust).toContain('This is Sub Component');
    // … and the whole bundle is byte-identical (the engines are differential-tested).
    expect(rust).toBe(js);
  });

  it('engine: "rust" runs L0/L1/L1.5 even when L2 is on by default (L2 skipped)', async () => {
    // Default level enables L2, which is JS-only; engine: "rust" must still shake
    // the dead branch (skipping L2) rather than throw or no-op.
    const code = await bundle([shaker({ include: ['.'], engine: 'rust' })]);
    expect(code).not.toMatch(IF_MACHINERY);
    expect(code).toContain('This is Sub Component');
  });
});
