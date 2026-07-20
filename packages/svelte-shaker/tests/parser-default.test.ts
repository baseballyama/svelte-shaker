import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build, type Rollup } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// ----------------------------------------------------------------------
// The Vite plugin parses with rsvelte BY DEFAULT: a bare `shaker()` must load
// the rsvelte parser from `@rsvelte/compiler` (a bundled WASM dependency), and
// `parser: 'svelte'` is the explicit opt-out to svelte/compiler (the fallback for
// rsvelte bugs). We wrap the real loader so we can both (a) observe that the
// default path reaches for it and the opt-out does not, and (b) force a load
// failure to prove the default THROWS with a message pointing at the dependency /
// the opt-out.
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

describe('vite-plugin-svelte-shaker: rsvelte is the default parser', () => {
  it('a bare shaker() loads the rsvelte native parser and shakes', async () => {
    const code = await bundle([shaker({ include: ['.'] })]);
    expect(loadRsvelte).toHaveBeenCalled(); // default reached for rsvelte
    expect(code).not.toMatch(IF_MACHINERY); // and shook the dead branch
    expect(code).toContain('This is Sub Component');
  });

  it("parser: 'svelte' opts out — svelte/compiler is used, rsvelte is never loaded", async () => {
    const code = await bundle([shaker({ include: ['.'], parser: 'svelte' })]);
    expect(loadRsvelte).not.toHaveBeenCalled();
    expect(code).not.toMatch(IF_MACHINERY);
    expect(code).toContain('This is Sub Component');
  });

  it('default throws when @rsvelte/compiler cannot be loaded, pointing at the dependency and the opt-out', async () => {
    loadRsvelte.mockReturnValue(null); // simulate a broken install / wasm that won't instantiate
    await expect(bundle([shaker({ include: ['.'] })])).rejects.toThrow(/@rsvelte\/compiler/);
    loadRsvelte.mockReturnValue(null);
    await expect(bundle([shaker({ include: ['.'] })])).rejects.toThrow(/parser: "svelte"/);
  });

  it("parser: 'svelte' still works when @rsvelte/compiler is unavailable (it is the fallback)", async () => {
    loadRsvelte.mockReturnValue(null);
    const code = await bundle([shaker({ include: ['.'], parser: 'svelte' })]);
    expect(loadRsvelte).not.toHaveBeenCalled(); // opt-out never touches the rsvelte loader
    expect(code).not.toMatch(IF_MACHINERY);
  });
});
