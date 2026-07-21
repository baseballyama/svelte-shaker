// ----------------------------------------------------------------------
// Shell-side glob for the two directory scans (docs/ARCHITECTURE.md §4.2, §8.1.1):
// which files are DEV-ONLY — they never ship in the production bundle, so their
// call sites must not count toward the shake.  Kept OUT of the env-free engine
// core (docs §5): it depends on `picomatch` and `node:path`.  Both scans — the
// `.svelte` seed scan (`collectSvelteFiles`) and the non-`.svelte` escape scan
// (`collectNonSvelteModules`) — take the SAME compiled predicate, so a dev-only
// file is discounted by both.
// ----------------------------------------------------------------------
import picomatch from 'picomatch';
import * as path from 'node:path';
import type { ComponentId } from './ir.js';

/**
 * Files treated as DEV-ONLY by default: colocated tests, mocks, and Storybook
 * stories — files that never ship, so their call sites must not count toward the
 * shake.  Discounting them is sound precisely because they never reach production;
 * see docs/ARCHITECTURE.md §8.1.1 for the full argument (why a glob is safe here but
 * not for narrowing app coverage, and the shipped-file-matching failure mode).
 * Passing `devOnly` REPLACES this list; `devOnly: []` counts every file.
 */
export const DEFAULT_DEV_ONLY: readonly string[] = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/__tests__/**',
  '**/__mocks__/**',
  '**/*.stories.*',
];

/** Predicate over an ABSOLUTE path: `true` when the file is dev-only (discounted by a scan). */
export type DevOnlyFilter = (file: ComponentId) => boolean;

const NONE_DEV_ONLY: DevOnlyFilter = () => false;

/**
 * Compile dev-only `patterns` into a {@link DevOnlyFilter}.  Each candidate path is
 * matched (with `picomatch`) as its `base`-relative, posix-normalized form, so the
 * result is OS-independent (backslashes on Windows are folded to `/`).  `base` is
 * the Vite root for the plugin and the scanned dir for a standalone `svelte-shaker/node`
 * caller.  Compile ONCE and reuse across the whole walk — never per file.
 *
 * Defaults to {@link DEFAULT_DEV_ONLY}; an empty `patterns` array matches nothing, so
 * `devOnly: []` counts every file (the pre-`devOnly` behavior).
 */
export function compileDevOnly(
  base: string,
  patterns: readonly string[] = DEFAULT_DEV_ONLY,
): DevOnlyFilter {
  if (patterns.length === 0) return NONE_DEV_ONLY;
  const isMatch = picomatch([...patterns]);
  return (file) => isMatch(path.relative(base, file).split(path.sep).join('/'));
}
