// ----------------------------------------------------------------------
// Node-only Shell glue (docs/ARCHITECTURE.md §5).  Kept OUT of `index.ts` so the
// engine core has no `node:*` imports and runs unchanged in the browser.
// This is the `svelte-shaker/node` entry point — its exports are a public contract.
// ----------------------------------------------------------------------
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ComponentId } from './ir.js';
import type { Resolve, ReadFile } from './analyze.js';
import { compileDevOnly, type DevOnlyFilter } from './dev-only.js';
import { excludeNothing, type ExcludeFilter } from './exclude.js';
import { walkDir } from './walk-dir.js';

// The escape-scan machinery lives in `./escape-scan.js` (internal); only the single
// entry helper is part of the public `svelte-shaker/node` surface.
export { computeEscapedComponents, type EscapeScanResult } from './escape-scan.js';

// The dev-only glob support (docs §8.1.1) is Shell-side and part of the public
// `svelte-shaker/node` surface, so a plain-Rollup pipeline can compile the same
// predicate the Vite plugin does and feed it to both scans.
export { DEFAULT_DEV_ONLY, compileDevOnly, type DevOnlyFilter } from './dev-only.js';

// Build-output exclusion (docs §8.1.1): the same "compile a predicate, feed both
// scans" shape as `devOnly`, exposed on `svelte-shaker/node` so a plain-Rollup
// pipeline can prune a compiled-output tree exactly as the Vite plugin does.
export { compileExclude, excludeNothing, type ExcludeFilter } from './exclude.js';

/** Default filesystem resolver: resolve `source` relative to its importer. */
export const fsResolve: Resolve = (source, importer) => {
  if (!source.startsWith('.')) return null; // bare imports aren't local components
  return path.resolve(path.dirname(importer), source);
};

/** Default filesystem reader. */
export const fsReadFile: ReadFile = (id) => fs.readFileSync(id, 'utf-8');

/**
 * Recursively collect every `.svelte` file under `dir` (skipping `node_modules`
 * and dot-directories).  A Shell helper, kept out of the env-free engine core
 * (docs/ARCHITECTURE.md §5): plugins use it to seed the whole-program crawl.
 *
 * `devOnly` lists files that never ship in the production bundle (tests, stories);
 * a match stops counting as a component consumer, so it is not seeded as an entry
 * and cannot pessimize the shake (docs §8.1.1).  A matched file the app actually
 * imports is still crawled and shaken through the normal graph — this only removes
 * it as a SEED.  Omitted, it defaults to {@link DEFAULT_DEV_ONLY} matched relative
 * to `dir`; the Vite plugin passes a predicate compiled against the Vite ROOT so a
 * custom pattern is root-relative there.  Pass `compileDevOnly(dir, [])` to seed
 * every file.
 */
export function collectSvelteFiles(
  dir: string,
  devOnly: DevOnlyFilter = compileDevOnly(dir),
  exclude: ExcludeFilter = excludeNothing,
): ComponentId[] {
  const out: ComponentId[] = [];
  walkDir(dir, exclude, (name, full) => name.endsWith('.svelte') && !devOnly(full), out);
  return out;
}
