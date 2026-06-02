import { defineConfig } from 'vitest/config';

// This suite includes heavy end-to-end integration tests: `bundle.test.ts`
// compiles three full Vite bundles per case, and `dev-vite.test.ts` boots real
// Vite dev servers.  vitest's 5s default per-test timeout is too tight for a
// cold CI runner (the L2 bundle bench alone can take ~8s there), so raise it
// suite-wide.  30s still catches a genuine hang.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
