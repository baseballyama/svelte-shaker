import { createRequire } from 'node:module';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build, type Rollup } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Whether a native binary exists in this environment, decided at COLLECTION time (so
// `it.skipIf` can read it) by probing the addon directly — the mock below cannot be
// consulted this early. The native-default assertions only hold when it is present;
// the fallback / opt-out tests force whatever state they need.
const nativeAvailable = (() => {
  const dylib = fileURLToPath(
    new URL(
      `../engine-scan-native/target/debug/${
        process.platform === 'darwin'
          ? 'libsvelte_shaker_engine_scan_native.dylib'
          : process.platform === 'win32'
            ? 'svelte_shaker_engine_scan_native.dll'
            : 'libsvelte_shaker_engine_scan_native.so'
      }`,
      import.meta.url,
    ),
  );
  if (!existsSync(dylib)) return false;
  try {
    const addon = createRequire(import.meta.url)('../engine-scan-native/index.cjs') as {
      ShakeSession?: unknown;
    };
    return typeof addon.ShakeSession === 'function';
  } catch {
    return false;
  }
})();

// ----------------------------------------------------------------------
// The `parser` option controls how the JS / WASM engines parse `.svelte` — the
// default FOLLOWS THE ENGINE (rsvelte on the WASM Rust engine, svelte/compiler on the
// JS engine, where rsvelte's parse is pure overhead). The NATIVE (napi) engine parses
// with rsvelte IN PROCESS and never touches the JS-side `@rsvelte/compiler`, so the
// `parser` option does not apply to it; `parser: 'svelte'` forces the native engine
// OFF (it cannot honor svelte/compiler). We wrap both loaders so we can (a) observe
// which paths reach for the JS rsvelte parser, and (b) force load failures to prove
// the fallback / opt-out behavior.
// ----------------------------------------------------------------------

vi.mock('../src/rsvelte-parse', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/rsvelte-parse')>();
  return { tryLoadRsvelteParser: vi.fn(orig.tryLoadRsvelteParser) };
});
vi.mock('../src/native-engine', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/native-engine')>();
  return { ...orig, tryLoadNativeEngine: vi.fn(orig.tryLoadNativeEngine) };
});

import { shaker } from '../src/vite';
import { tryLoadRsvelteParser } from '../src/rsvelte-parse';
import { tryLoadNativeEngine } from '../src/native-engine';

const loadRsvelte = vi.mocked(tryLoadRsvelteParser);
const loadNative = vi.mocked(tryLoadNativeEngine);

const APP = join(dirname(fileURLToPath(import.meta.url)), '.shaker-tmp-parser-default');

const FILES: Record<string, string> = {
  'main.ts': `import { mount } from 'svelte';\nimport App from './App.svelte';\nmount(App, { target: document.body });\n`,
  'App.svelte': `<script lang="ts">\n  import Sub from './Sub.svelte';\n</script>\n\n<Sub hasIcon={false} />\n`,
  'Sub.svelte': `<script lang="ts">\n  let { hasIcon }: { hasIcon: boolean } = $props();\n</script>\n\n{#if hasIcon}\n  <p>Icon</p>\n{/if}\n\n<p>This is Sub Component</p>\n`,
};

/** Conditional-rendering machinery Svelte emits for a surviving `{#if}`. */
const IF_MACHINERY = /\bif_block\b|\$\.if\(/;

// The genuine loaders, so each test can start from the real behavior and only the
// failure tests force a `null` (peer-unavailable) return.
let realLoad: typeof tryLoadRsvelteParser;
let realLoadNative: typeof tryLoadNativeEngine;

beforeAll(async () => {
  const rsv = await vi.importActual<typeof import('../src/rsvelte-parse')>('../src/rsvelte-parse');
  realLoad = rsv.tryLoadRsvelteParser;
  const nat = await vi.importActual<typeof import('../src/native-engine')>('../src/native-engine');
  realLoadNative = nat.tryLoadNativeEngine;
  rmSync(APP, { recursive: true, force: true });
  mkdirSync(APP, { recursive: true });
  for (const [name, content] of Object.entries(FILES)) writeFileSync(join(APP, name), content);
});

afterAll(() => rmSync(APP, { recursive: true, force: true }));

beforeEach(() => {
  loadRsvelte.mockReset();
  loadRsvelte.mockImplementation((...args) => realLoad(...args));
  loadNative.mockReset();
  loadNative.mockImplementation((...args) => realLoadNative(...args));
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

describe('vite-plugin-svelte-shaker: parser follows the engine', () => {
  it.skipIf(!nativeAvailable)(
    'a bare shaker() on a tiny app uses the native engine — in-process rsvelte, no JS parser',
    async () => {
      const code = await bundle([shaker({ entries: ['.'] })]);
      // The native engine parses in process, so it never reaches for the JS-side rsvelte.
      expect(loadRsvelte).not.toHaveBeenCalled();
      expect(code).not.toMatch(IF_MACHINERY); // and it shook the dead branch
      expect(code).toContain('This is Sub Component');
    },
  );

  it.skipIf(!nativeAvailable)(
    "engine: 'rust' uses the native engine — no JS parser loaded",
    async () => {
      const code = await bundle([shaker({ entries: ['.'], engine: 'rust' })]);
      expect(loadRsvelte).not.toHaveBeenCalled();
      expect(code).not.toMatch(IF_MACHINERY);
    },
  );

  it("engine: 'js' defaults to svelte/compiler — rsvelte is never loaded", async () => {
    const code = await bundle([shaker({ entries: ['.'], engine: 'js' })]);
    expect(loadRsvelte).not.toHaveBeenCalled(); // JS engine -> svelte default, no rsvelte overhead
    expect(code).not.toMatch(IF_MACHINERY);
    expect(code).toContain('This is Sub Component');
  });

  it("parser: 'svelte' forces the native engine off and uses svelte/compiler", async () => {
    const code = await bundle([shaker({ entries: ['.'], parser: 'svelte' })]);
    expect(loadRsvelte).not.toHaveBeenCalled();
    expect(code).not.toMatch(IF_MACHINERY);
    expect(code).toContain('This is Sub Component');
  });

  it("parser: 'rsvelte' forces the JS rsvelte parser on the JS engine", async () => {
    const code = await bundle([shaker({ entries: ['.'], engine: 'js', parser: 'rsvelte' })]);
    expect(loadRsvelte).toHaveBeenCalled(); // explicit parser overrides the engine default
    expect(code).not.toMatch(IF_MACHINERY);
  });

  it('the WASM fallback throws when @rsvelte/compiler cannot be loaded, pointing at the dependency and the opt-out', async () => {
    // With the native engine unavailable, engine: 'rust' falls back to the WASM engine,
    // which parses `.svelte` with the JS rsvelte parser — so a missing @rsvelte/compiler
    // is a hard error there (a silent swap would shake differently machine to machine).
    loadNative.mockReturnValue(null);
    loadRsvelte.mockReturnValue(null);
    await expect(bundle([shaker({ entries: ['.'], engine: 'rust' })])).rejects.toThrow(
      /@rsvelte\/compiler/,
    );
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
