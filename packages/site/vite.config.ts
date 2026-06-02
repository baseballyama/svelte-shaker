import { sveltekit } from '@sveltejs/kit/vite';
import { shaker } from 'svelte-shaker/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    // Dogfooding: the site tree-shakes its own components with svelte-shaker
    // (build-only, enforce:'pre'), then hands the slimmed source to the Svelte
    // compiler — which here is rsvelte (see package.json: @sveltejs/vite-plugin-svelte
    // is aliased to @rsvelte/vite-plugin-svelte).
    shaker({ include: ['src'] }),
    sveltekit(),
  ],
  // The shaker engine and svelte/compiler are bundled for the browser.
  optimizeDeps: { include: ['svelte-shaker', 'svelte/compiler'] },
});
