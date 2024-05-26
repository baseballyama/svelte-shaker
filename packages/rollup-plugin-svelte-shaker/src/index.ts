import { svelteShaker } from 'svelte-shaker';
import type { Plugin } from 'rollup';

const rollupPluginSvelteShaker = (): Plugin[] => {
  let preProcessed = false;
  let shakedSvelteFiles: Record<string, string> = {};
  return [
    {
      name: 'svelte-shaker',
      async load(id) {
        if (preProcessed) return undefined;
        if (id.endsWith('.svelte')) {
          shakedSvelteFiles = await svelteShaker(id, async (path: string) => {
            const resolved = await this.resolve(path);
            return resolved?.id;
          });
        }
      },
    },
  ];
};

export default rollupPluginSvelteShaker;
