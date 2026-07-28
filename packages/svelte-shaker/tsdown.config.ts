import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    vite: 'src/vite.ts',
    scan: 'src/scan.ts',
  },
  clean: true,
  deps: {
    neverBundle: true,
  },
  dts: true,
  fixedExtension: false,
  format: 'esm',
  minify: true,
  platform: 'node',
  target: 'esnext',
  treeshake: true,
  tsconfig: 'tsconfig.build.json',
});
