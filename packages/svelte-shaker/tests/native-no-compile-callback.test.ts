import { resolve as resolvePath } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The WHOLE POINT of the native engine: when it is active, the monomorphization
// net-win gate's size proxy is computed IN RUST by rsvelte (`session::own_size`), so
// the hot path never calls back into the JS Svelte compiler. We pin that here by
// spying on `svelte/compiler`'s `compile` — the size-proxy call the WASM/TS engines
// make — and asserting the native shake makes ZERO such calls even while
// monomorphization genuinely fires. `parse` is left real: the OUTER revert-cascade
// validation deliberately re-parses changed files with svelte/compiler (the authority,
// docs §6.5), which is a `parse`, not the `compile` size callback this guards.
// `vi.mock` is hoisted above module init, so the spy must come from `vi.hoisted`.
const { compileSpy } = vi.hoisted(() => ({
  compileSpy: vi.fn(() => {
    throw new Error('svelte/compiler.compile must not run on the native path');
  }),
}));
vi.mock('svelte/compiler', async (importOriginal) => {
  const orig = await importOriginal<typeof import('svelte/compiler')>();
  return { ...orig, compile: compileSpy };
});

import { svelteShakerNativeWithMono, tryLoadNativeEngine } from '../src/native-engine';
import { fsReadFile, fsResolve } from '../src/scan';

const engine = tryLoadNativeEngine();
const FIXTURES = resolvePath(__dirname, 'fixtures');
const MONO_ON = { enabled: true, maxVariants: 8, minSavings: 0 };

afterEach(() => compileSpy.mockClear());

describe.skipIf(!engine)('native path makes no svelte/compiler size callback', () => {
  it('monomorphization fires (mono-correlated) with zero compile() calls', async () => {
    const entry = resolvePath(FIXTURES, 'mono-correlated', 'input', 'App.svelte');
    const result = await svelteShakerNativeWithMono(engine!, entry, fsResolve, fsReadFile, MONO_ON);

    // The gate ran and specialized (so the size proxy WAS consulted — in Rust)...
    expect(result.variants.size).toBeGreaterThan(0);
    // ...yet the JS Svelte compiler was never invoked for it.
    expect(compileSpy).not.toHaveBeenCalled();
  });
});
