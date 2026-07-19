// ----------------------------------------------------------------------
// Node-only Shell glue (docs/ARCHITECTURE.md §5).  Kept OUT of `index.ts` so the
// engine core has no `node:*` imports and runs unchanged in the browser.
// This is the `svelte-shaker/node` entry point — its exports are a public contract.
// ----------------------------------------------------------------------
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ComponentId } from './ir.js';
import type { Resolve, ReadFile } from './analyze.js';

// The escape-scan machinery lives in `./escape-scan.js` (internal); only the single
// entry helper is part of the public `svelte-shaker/node` surface.
export { computeEscapedComponents, type EscapeScanResult } from './escape-scan.js';

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
 */
export function collectSvelteFiles(dir: string): ComponentId[] {
  const out: ComponentId[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectSvelteFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.svelte')) out.push(full);
  }
  return out;
}
