const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { gzipSync } = require('node:zlib');

const MAX_BINARY_BYTES = 8_000_000;
const names = {
  darwin: 'libsvelte_shaker_engine_scan_native.dylib',
  linux: 'libsvelte_shaker_engine_scan_native.so',
  win32: 'svelte_shaker_engine_scan_native.dll',
};
const binary =
  process.argv[2] ?? path.join(__dirname, '..', 'target', 'release', names[process.platform]);
const content = fs.readFileSync(binary);
const gzipBytes = gzipSync(content, { level: 9 }).byteLength;

assert.ok(
  content.byteLength <= MAX_BINARY_BYTES,
  `${binary} is ${content.byteLength} B (limit ${MAX_BINARY_BYTES} B)`,
);

console.log(`native size: ${content.byteLength} B raw / ${gzipBytes} B gzip (${binary})`);
