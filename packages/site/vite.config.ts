import { sveltekit } from '@sveltejs/kit/vite';
import { shaker } from 'svelte-shaker/vite';
import { defineConfig, type PluginOption } from 'vite';

export default defineConfig({
  plugins: [
    // Dogfooding: the site tree-shakes its own components with svelte-shaker
    // (build-only, enforce:'pre'), then hands the slimmed source to the Svelte
    // compiler — which here is rsvelte (see package.json: @sveltejs/vite-plugin-svelte
    // is aliased to @rsvelte/vite-plugin-svelte).
    //
    // `shaker` is typed against svelte-shaker's own vite (^5); the site runs on
    // vite ^6. A vite plugin is structurally identical across these majors, so
    // the object is a valid plugin at runtime — bridge the two `Plugin` types.
    shaker({ entries: ['src'] }) as PluginOption,
    sveltekit(),
  ],
  // The shaker engine and svelte/compiler are bundled for the browser.
  optimizeDeps: { include: ['svelte-shaker', 'svelte/compiler'] },
});
