import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// GitHub Pages serves a project site under /<repo>/. The deploy workflow sets
// BASE_PATH=/svelte-shaker; local dev/build use the root.
const base = process.env.BASE_PATH ?? '';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({ fallback: '404.html', precompress: false }),
    paths: { base },
    appDir: 'app',
  },
};

export default config;
