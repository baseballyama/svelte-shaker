import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { build, type Rollup } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// ----------------------------------------------------------------------
// The native addon is published separately from `svelte-shaker` and versioned in
// lockstep. When `shake` dropped its JS `ownSize` callback (0.2.x → 0.3.x), driving
// an OLD 0.2.x binary the new one-argument way throws a napi TypeError that — with no
// guard — crashes `vite build`. Two defenses, both pinned here:
//   1. `hasSessionApi` REJECTS a binary whose `engineApiVersion` is missing/wrong, so
//      the loader never returns an ABI-incompatible addon (it degrades to WASM/JS).
//   2. Even so, any OTHER native runtime failure is caught in the plugin and degrades
//      to the JS engine with a warning, never a crashed build.
// ----------------------------------------------------------------------

describe('native addon ABI guard (hasSessionApi)', () => {
  // Imported lazily so the mock below (for the degradation test) does not shadow it.
  it('rejects a 0.2.x-shaped addon (ShakeSession present, no engineApiVersion)', async () => {
    const { hasSessionApi } =
      await vi.importActual<typeof import('../src/native-engine')>('../src/native-engine');
    class OldSession {
      parse() {}
      parseMore() {}
      // 0.2.x: shake took (configJson, ownSize) — the two-arg form.
      shake(_config: string, _ownSize: unknown) {}
    }
    // No `engineApiVersion` export — exactly the 0.2.x shape. Must be rejected so the
    // caller falls back instead of calling the new one-arg `shake` on it.
    expect(hasSessionApi({ ShakeSession: OldSession as never })).toBe(false);
  });

  it('rejects a future/mismatched ABI generation, accepts the current one', async () => {
    const { hasSessionApi } =
      await vi.importActual<typeof import('../src/native-engine')>('../src/native-engine');
    class Session {
      parse() {}
      parseMore() {}
      shake(_config: string) {}
    }
    expect(hasSessionApi({ ShakeSession: Session as never, engineApiVersion: () => 99 })).toBe(
      false,
    );
    expect(hasSessionApi({ ShakeSession: Session as never, engineApiVersion: () => 3 })).toBe(true);
  });
});

// The degradation-to-JS test drives a real `vite build` with the native engine forced
// to fail at runtime, so it mocks the native module for the whole file. Kept in a
// separate `describe` after the pure `hasSessionApi` checks (which read the REAL module
// via `vi.importActual`).
vi.mock('../src/native-engine', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/native-engine')>();
  return {
    ...orig,
    // A loadable-looking native engine, so the plugin enters the native branch...
    tryLoadNativeEngine: () => ({ ShakeSession: class {}, engineApiVersion: () => 3 }),
    // ...whose whole-program shake then throws, exercising the plugin's catch/degrade.
    svelteShakerNativeWithMono: () => {
      throw new Error('simulated native crash');
    },
  };
});

const APP = join(dirname(fileURLToPath(import.meta.url)), '.shaker-tmp-native-degrade');
const FILES: Record<string, string> = {
  'main.ts': `import { mount } from 'svelte';\nimport App from './App.svelte';\nmount(App, { target: document.body });\n`,
  'App.svelte': `<script lang="ts">\n  import Sub from './Sub.svelte';\n</script>\n\n<Sub hasIcon={false} />\n`,
  'Sub.svelte': `<script lang="ts">\n  let { hasIcon }: { hasIcon: boolean } = $props();\n</script>\n\n{#if hasIcon}\n  <p>Icon</p>\n{/if}\n\n<p>This is Sub Component</p>\n`,
};

beforeAll(() => {
  rmSync(APP, { recursive: true, force: true });
  mkdirSync(APP, { recursive: true });
  for (const [name, content] of Object.entries(FILES)) writeFileSync(join(APP, name), content);
});
afterAll(() => rmSync(APP, { recursive: true, force: true }));

describe('native runtime failure degrades to the JS engine', () => {
  it('a throwing native shake still produces a shaken build (dead branch removed)', async () => {
    const { shaker } = await import('../src/vite');
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
      plugins: [shaker({ entries: ['.'] }), svelte({ compilerOptions: { runes: true } })] as any,
    })) as Rollup.RollupOutput;
    const code = result.output.map((c) => ('code' in c ? c.code : '')).join('\n');

    // The build did NOT crash, and the JS-engine fallback shook the dead `{#if}` arm.
    expect(code).toContain('This is Sub Component');
    expect(code).not.toMatch(/\bif_block\b|\$\.if\(/);
  });
});
