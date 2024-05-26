import typescript from '@rollup/plugin-typescript';
import commonjs from '@rollup/plugin-commonjs';
import resolve from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import { defineConfig } from 'rollup';

export default defineConfig({
  input: 'src/index.ts',
  output: [
    {
      file: 'dist/index.js',
      format: 'esm',
    },
    {
      file: 'dist/index.cjs',
      format: 'cjs',
      name: 'svelteShaker',
    },
  ],
  plugins: [
    resolve(),
    commonjs(),
    typescript({ tsconfig: 'tsconfig.json' }),
    terser(),
  ],
});
