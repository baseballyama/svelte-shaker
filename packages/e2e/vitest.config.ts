import { defineConfig } from 'vitest/config';

// Each test case runs up to three full Vite SSR/client builds (control,
// shaken, smoke).  On a cold CI runner these easily exceed the 5 s default.
// 120 s still catches a genuine hang while giving mode-watcher's transitive
// compile plenty of headroom.
export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
});
