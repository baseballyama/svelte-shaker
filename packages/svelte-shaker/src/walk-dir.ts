// ----------------------------------------------------------------------
// Node-only Shell glue (docs/ARCHITECTURE.md §5): the one recursive directory
// walker both source scans share.  `collectSvelteFiles` (seed `.svelte` files) and
// `collectNonSvelteModules` (escape-scan JS/TS modules) differ ONLY in which files
// they keep, so they pass a `predicate` and reuse the same traversal — the same
// `node_modules`/dot-directory skip and the same `exclude` pruning, so both scans
// see the same tree (docs §8.1.1).  Kept out of the env-free engine core.
// ----------------------------------------------------------------------
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExcludeFilter } from './exclude.js';

/**
 * Recursively collect every file under `dir` that `predicate` accepts, into `out`.
 * Skips `node_modules` and dot-directories, and prunes any directory `exclude`
 * matches (a compiled-output tree, docs §8.1.1).  `predicate` receives both the
 * bare entry name and its full path (the seed scan tests the extension; both scans
 * also discount `devOnly` files via the full path).  An unreadable directory is
 * skipped (it contributes nothing), matching each scan's prior behavior.
 */
export function walkDir(
  dir: string,
  exclude: ExcludeFilter,
  predicate: (name: string, full: string) => boolean,
  out: string[],
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (exclude(full)) continue; // a build-output tree — pruned from the scan
      walkDir(full, exclude, predicate, out);
    } else if (entry.isFile() && predicate(entry.name, full)) out.push(full);
  }
}
