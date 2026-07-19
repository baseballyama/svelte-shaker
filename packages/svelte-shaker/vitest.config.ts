import { defineConfig, defaultExclude } from 'vitest/config';

// This suite includes heavy end-to-end integration tests: `bundle.test.ts`
// compiles three full Vite bundles per case, and `dev-vite.test.ts` boots real
// Vite dev servers.  vitest's 5s default per-test timeout is too tight for a
// cold CI runner (the monomorphization bundle bench alone can take ~8s there), so raise it
// suite-wide.  30s still catches a genuine hang.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // `engine-scan-native/.rsvelte-src` is a git-ignored local checkout used to
    // build the native scanner; its own test suites must not run as ours.
    exclude: [...defaultExclude, 'engine-scan-native/.rsvelte-src/**'],
  },
});
