import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build, type Rollup } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// ----------------------------------------------------------------------
// The Vite plugin's default parser FOLLOWS THE ENGINE: rsvelte on the native
// (Rust) engine, svelte/compiler on the JS engine (where rsvelte's parse is pure
// overhead).  A tiny app on `auto` selects the native engine, so a bare `shaker()`
// must load the rsvelte parser from `@rsvelte/compiler`; `engine: 'js'` selects the
// JS engine and so must NOT load rsvelte; `parser: 'svelte'`/`'rsvelte'` pin one
// parser regardless.  We wrap the real loader so we can (a) observe which paths
// reach for rsvelte, and (b) force a load failure to prove the rsvelte-resolved
// path THROWS with a message pointing at the dependency / the opt-out.
// ----------------------------------------------------------------------

vi.mock('../src/rsvelte-parse', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/rsvelte-parse')>();
  return { tryLoadRsvelteParser: vi.fn(orig.tryLoadRsvelteParser) };
});

import { shaker } from '../src/vite';
import { tryLoadRsvelteParser } from '../src/rsvelte-parse';

const loadRsvelte = vi.mocked(tryLoadRsvelteParser);

const APP = join(dirname(fileURLToPath(import.meta.url)), '.shaker-tmp-parser-default');

const FILES: Record<string, string> = {
  'main.ts': `import { mount } from 'svelte';\nimport App from './App.svelte';\nmount(App, { target: document.body });\n`,
  'App.svelte': `<script lang="ts">\n  import Sub from './Sub.svelte';\n</script>\n\n<Sub hasIcon={false} />\n`,
  'Sub.svelte': `<script lang="ts">\n  let { hasIcon }: { hasIcon: boolean } = $props();\n</script>\n\n{#if hasIcon}\n  <p>Icon</p>\n{/if}\n\n<p>This is Sub Component</p>\n`,
};

/** Conditional-rendering machinery Svelte emits for a surviving `{#if}`. */
const IF_MACHINERY = /\bif_block\b|\$\.if\(/;

// The genuine loader, so each test can start from the real behavior and only the
// throw tests force a `null` (peer-unavailable) return.
let realLoad: typeof tryLoadRsvelteParser;

beforeAll(async () => {
  const orig = await vi.importActual<typeof import('../src/rsvelte-parse')>('../src/rsvelte-parse');
  realLoad = orig.tryLoadRsvelteParser;
  rmSync(APP, { recursive: true, force: true });
  mkdirSync(APP, { recursive: true });
  for (const [name, content] of Object.entries(FILES)) writeFileSync(join(APP, name), content);
});

afterAll(() => rmSync(APP, { recursive: true, force: true }));

beforeEach(() => {
  loadRsvelte.mockReset();
  loadRsvelte.mockImplementation(realLoad);
});

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

describe('vite-plugin-svelte-shaker: default parser follows the engine', () => {
  it('a bare shaker() on a tiny app (native engine) loads rsvelte and shakes', async () => {
    const code = await bundle([shaker({ entries: ['.'] })]);
    expect(loadRsvelte).toHaveBeenCalled(); // native engine -> rsvelte default
    expect(code).not.toMatch(IF_MACHINERY); // and shook the dead branch
    expect(code).toContain('This is Sub Component');
  });

  it("engine: 'js' defaults to svelte/compiler — rsvelte is never loaded", async () => {
    const code = await bundle([shaker({ entries: ['.'], engine: 'js' })]);
    expect(loadRsvelte).not.toHaveBeenCalled(); // JS engine -> svelte default, no rsvelte overhead
    expect(code).not.toMatch(IF_MACHINERY);
    expect(code).toContain('This is Sub Component');
  });

  it("engine: 'rust' keeps rsvelte as the default parser", async () => {
    const code = await bundle([shaker({ entries: ['.'], engine: 'rust' })]);
    expect(loadRsvelte).toHaveBeenCalled();
    expect(code).not.toMatch(IF_MACHINERY);
  });

  it("parser: 'svelte' opts out — svelte/compiler is used, rsvelte is never loaded", async () => {
    const code = await bundle([shaker({ entries: ['.'], parser: 'svelte' })]);
    expect(loadRsvelte).not.toHaveBeenCalled();
    expect(code).not.toMatch(IF_MACHINERY);
    expect(code).toContain('This is Sub Component');
  });

  it("parser: 'rsvelte' forces rsvelte even on the JS engine", async () => {
    const code = await bundle([shaker({ entries: ['.'], engine: 'js', parser: 'rsvelte' })]);
    expect(loadRsvelte).toHaveBeenCalled(); // explicit parser overrides the engine default
    expect(code).not.toMatch(IF_MACHINERY);
  });

  it('a rsvelte-resolved default throws when @rsvelte/compiler cannot be loaded, pointing at the dependency and the opt-out', async () => {
    loadRsvelte.mockReturnValue(null); // simulate a broken install / wasm that won't instantiate
    await expect(bundle([shaker({ entries: ['.'], engine: 'rust' })])).rejects.toThrow(
      /@rsvelte\/compiler/,
    );
    loadRsvelte.mockReturnValue(null);
    await expect(bundle([shaker({ entries: ['.'], engine: 'rust' })])).rejects.toThrow(
      /parser: "svelte"/,
    );
  });

  it("parser: 'svelte' still works when @rsvelte/compiler is unavailable (it is the fallback)", async () => {
    loadRsvelte.mockReturnValue(null);
    const code = await bundle([shaker({ entries: ['.'], parser: 'svelte' })]);
    expect(loadRsvelte).not.toHaveBeenCalled(); // opt-out never touches the rsvelte loader
    expect(code).not.toMatch(IF_MACHINERY);
  });
});
