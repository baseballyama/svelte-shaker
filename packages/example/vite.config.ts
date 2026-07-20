import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { shaker } from 'svelte-shaker/vite';

// https://vitejs.dev/config/
export default defineConfig({
  // `shaker` must come before `svelte()` so it slims the `.svelte` source
  // before the Svelte compiler runs. It is build-only by design (dev passes
  // through). `entries` is where the crawl starts — `src` holds every call site.
  plugins: [shaker({ entries: ['src'] }), svelte()],
  build: {
    minify: false,
  },
});
