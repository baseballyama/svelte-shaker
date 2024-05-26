import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { Plugin } from 'rollup';

const myPlugin = (): Plugin[] => {
  let preProcessed = false;
  return [
    {
      name: 'my-plugin',
      async load(id) {
        if (preProcessed) return undefined;
        if (id.endsWith('.svelte')) {
          console.log(await this.resolve(id));
        }
      },
    },
  ];
};

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [myPlugin, svelte()],
  build: {
    minify: false,
  },
});
