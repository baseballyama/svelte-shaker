import typescript from '@rollup/plugin-typescript';
import commonjs from '@rollup/plugin-commonjs';
import resolve from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import { defineConfig } from 'rollup';

const external = [/^svelte($|\/)/, /^node:/, 'vite', 'magic-string', 'zimmerframe'];

export default defineConfig([
  {
    input: 'src/index.ts',
    output: [
      { file: 'dist/index.js', format: 'esm' },
      { file: 'dist/index.cjs', format: 'cjs', name: 'svelteShaker' },
    ],
    external,
    plugins: [resolve(), commonjs(), typescript({ tsconfig: 'tsconfig.json' }), terser()],
  },
  {
    // The Vite plugin entry — self-contained (the engine is bundled in) so the
    // published `./vite` export has no intra-package resolution to satisfy.
    input: 'src/vite.ts',
    output: [{ file: 'dist/vite.js', format: 'esm' }],
    external,
    plugins: [resolve(), commonjs(), typescript({ tsconfig: 'tsconfig.json' }), terser()],
  },
  {
    // Node-only glue (`fsResolve`, `collectSvelteFiles`) — the `./node` entry.
    input: 'src/scan.ts',
    output: [{ file: 'dist/scan.js', format: 'esm' }],
    external,
    plugins: [resolve(), commonjs(), typescript({ tsconfig: 'tsconfig.json' }), terser()],
  },
]);
