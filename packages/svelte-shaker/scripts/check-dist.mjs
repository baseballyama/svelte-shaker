import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const MAX_DIST_BYTES = 110_000;
const MAX_JS_BYTES = 60_000;
const MAX_JS_GZIP_BYTES = 20_000;

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function filesUnder(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) => {
        const path = join(dir, entry.name);
        return entry.isDirectory() ? filesUnder(path) : [path];
      }),
    )
  ).flat();
}

const files = (await filesUnder(DIST)).sort();
const contents = await Promise.all(files.map((file) => readFile(file)));
const jsFiles = files.filter((file) => extname(file) === '.js');
const jsContents = await Promise.all(jsFiles.map((file) => readFile(file)));
const distBytes = contents.reduce((total, content) => total + content.byteLength, 0);
const jsBytes = jsContents.reduce((total, content) => total + content.byteLength, 0);
const jsGzipBytes = gzipSync(Buffer.concat(jsContents), {
  level: 9,
}).byteLength;

assert.ok(distBytes <= MAX_DIST_BYTES, `dist is ${distBytes} B (limit ${MAX_DIST_BYTES} B)`);
assert.ok(jsBytes <= MAX_JS_BYTES, `JS is ${jsBytes} B (limit ${MAX_JS_BYTES} B)`);
assert.ok(
  jsGzipBytes <= MAX_JS_GZIP_BYTES,
  `gzipped JS is ${jsGzipBytes} B (limit ${MAX_JS_GZIP_BYTES} B)`,
);

const expectedExports = {
  'index.js': [
    'DEFAULT_MONO_OPTIONS',
    'analyze',
    'buildAnalyzeInput',
    'svelteShaker',
    'svelteShakerWithMono',
  ],
  'scan.js': [
    'DEFAULT_DEV_ONLY',
    'collectSvelteFiles',
    'compileDevOnly',
    'compileExclude',
    'computeEscapedComponents',
    'excludeNothing',
    'fsReadFile',
    'fsResolve',
  ],
  'vite.js': ['DEFAULT_DEV_ONLY', 'shaker'],
};

for (const [entry, expected] of Object.entries(expectedExports)) {
  const module = await import(pathToFileURL(join(DIST, entry)).href);
  assert.deepEqual(Object.keys(module).sort(), expected);
}

const { shaker } = await import(pathToFileURL(join(DIST, 'vite.js')).href);
assert.equal(shaker().name, 'vite-plugin-svelte-shaker');

console.log(`dist size: ${distBytes} B; JS: ${jsBytes} B raw / ${jsGzipBytes} B gzip`);
