// ----------------------------------------------------------------------
// Build-output exclusion for the directory scans (docs/ARCHITECTURE.md §8.1.1).
// Shell-side glue, kept in its own module (like `dev-only.ts`) so both the
// `.svelte` seed scan (`scan.ts`) and the non-`.svelte` escape scan
// (`escape-scan.ts`) can share it without an import cycle.
// ----------------------------------------------------------------------
import * as path from 'node:path';

/**
 * A directory the scans must NOT descend into: a build-output tree.  Returns
 * `true` for an absolute path that is, or lives under, one of the declared roots.
 * Both directory walks ({@link import('./scan.js').collectSvelteFiles} and the
 * escape scan's `collectNonSvelteModules`) consult it, so a compiled-output dir is
 * pruned from BOTH — the same predicate feeds both scans, mirroring `devOnly`.
 */
export type ExcludeFilter = (absPath: string) => boolean;

/** Never excludes anything — the default when no build-output roots are declared. */
export const excludeNothing: ExcludeFilter = () => false;

/**
 * Compile an {@link ExcludeFilter} from build-output directory roots (the Vite
 * plugin's resolved `build.outDir` plus any user-declared `exclude`).  Each entry
 * is resolved against `root` (an absolute entry is left as-is), then matched on a
 * plain path-prefix basis — the same "directory or file prefix" basis as `entries`
 * / `preserve`, no glob.  Empty / omitted -> {@link excludeNothing}.
 *
 * Unlike `entries`, over-listing here errs UNSAFE (a pruned directory's call sites
 * stop counting, exactly as if it were outside the crawl), so it must name ONLY
 * generated build output, never source.  That is why nothing is excluded by
 * default: the plugin only ever seeds this with `build.outDir` (unconditionally
 * safe — it is the destination the current build overwrites) and whatever the user
 * explicitly declares via `exclude`.
 */
export function compileExclude(root: string, exclude?: string[]): ExcludeFilter {
  if (!exclude || exclude.length === 0) return excludeNothing;
  const prefixes = exclude.map((e) => path.resolve(root, e));
  return (absPath) => prefixes.some((p) => absPath === p || absPath.startsWith(p + path.sep));
}
