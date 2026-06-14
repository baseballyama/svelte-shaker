// Copy the built WASM engine artifacts into `dist/` so they ship inside the
// already-published `dist/` tree.  wasm-pack writes a `pkg/.gitignore` of `*`,
// which npm honors and would otherwise EXCLUDE `engine-rs/pkg` from the tarball
// even when listed in `files`; co-locating the artifacts in `dist/` sidesteps
// that.  The wasm-pack Node glue loads the binary via `${__dirname}/<name>.wasm`,
// so the `.js` and `.wasm` must land in the SAME directory.
//
// Runs after `tsc` in the `build`/`prepack` scripts.  Reads from the committed
// `engine-rs/pkg` (the release workflow does not recompile the Rust crate), so
// the checked-in WASM is the source of truth.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = join(root, 'engine-rs', 'pkg');
const dist = join(root, 'dist');

const FILES = ['svelte_shaker_engine.js', 'svelte_shaker_engine_bg.wasm'];

mkdirSync(dist, { recursive: true });
for (const name of FILES) {
  const from = join(pkg, name);
  if (!existsSync(from)) {
    throw new Error(
      `copy-wasm: missing ${from}. Run \`pnpm build:wasm\` to build the engine first.`,
    );
  }
  copyFileSync(from, join(dist, name));
}
console.info(`[copy-wasm] copied ${FILES.length} WASM artifact(s) into dist/`);
