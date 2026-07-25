import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { shaker } from 'svelte-shaker/vite';

// https://vitejs.dev/config/
export default defineConfig({
  // `shaker` must come before `svelte()` so it slims the `.svelte` source
  // before the Svelte compiler runs. It is build-only by design (dev passes
  // through). `entries` is where the crawl starts — `src` holds every call site.
  // `verbose` prints a per-file shake report so `pnpm build` visibly shows
  // what got folded/removed — see src/lib/Badge.svelte for what's exercised.
  plugins: [shaker({ entries: ['src'], verbose: true }), svelte()],
  build: {
    minify: false,
  },
});
