// ----------------------------------------------------------------------
// Internal Shell helper (docs/ARCHITECTURE.md §4.2): find the components used from
// OUTSIDE the analyzed `.svelte` graph — a `.ts`/`.js` call site the crawl cannot
// parse, or a user-declared `preserve`.  NOT part of the `svelte-shaker/node` public
// surface: only `computeEscapedComponents` is re-exported there (`scan.ts`).  The
// Vite Shell imports the rest of this module directly.
// ----------------------------------------------------------------------
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseModuleProgram, walk, type AnyNode } from './parse.js';
import type { ComponentId } from './ir.js';
import type { Resolve, ReadFile } from './analyze.js';
import { compileDevOnly, type DevOnlyFilter } from './dev-only.js';

/**
 * The non-`.svelte` module extensions we scan for `.svelte` call sites (docs
 * §4.2).  A component imported by any of these has a consumer the `.svelte`-only
 * crawl cannot see (`mount(Comp, …)`, a lazy `import()`), so it must escape.
 * `.svelte.js`/`.svelte.ts` rune modules match here too — they are plain modules,
 * not components, and can equally mount a component.
 */
const NON_SVELTE_MODULE_EXTS = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx'];

/**
 * Is `file` a module the escape scan reads — a non-`.svelte` JS/TS source
 * ({@link NON_SVELTE_MODULE_EXTS}), excluding `.d.ts` declaration files (types-only,
 * they never mount anything)?  Accepts a full path or a bare name.  The dev Shell
 * uses this to decide whether a changed file can shift the escape set (docs §4.2).
 */
export function isScannableModule(file: string): boolean {
  if (file.endsWith('.d.ts')) return false;
  return NON_SVELTE_MODULE_EXTS.some((ext) => file.endsWith(ext));
}

/**
 * Recursively collect every non-`.svelte` module under `dir` (skipping
 * `node_modules` and dot-directories, mirroring `collectSvelteFiles`).  Same
 * include scope as the seed scan — `.ts` inside `node_modules` is deliberately NOT
 * scanned (docs §4.2).  `devOnly` drops modules that never ship (a `Button.test.ts`)
 * so a colocated test does not mark the component it imports escaped (docs §8.1.1);
 * it is the SAME predicate the seed scan uses, so both scans discount the same files.
 */
function collectNonSvelteModules(dir: string, devOnly: DevOnlyFilter, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectNonSvelteModules(full, devOnly, out);
    else if (entry.isFile() && isScannableModule(entry.name) && !devOnly(full)) out.push(full);
  }
}

/**
 * Every module specifier a JS/TS module statically references: `import … from`,
 * `export … from` / `export *`, and a dynamic `import('…')` whose argument is a
 * STRING LITERAL.  A computed dynamic import (`import(expr)`) is unknowable here —
 * the `preserve` option (docs §4.2) is the sound fallback for it.  Parsed via
 * {@link parseModuleProgram} (the same TS-capable parse the engine's
 * barrel-following uses).  Returns `null` when the module does NOT parse — a JSX
 * body or exotic/bleeding-edge TS the wrapper rejects — because a parse failure
 * hides any call site inside, so the caller must surface it (a mounted component
 * would go un-escaped); `preserve` is the fix for that file.
 */
function moduleImportSpecifiers(code: string, id: ComponentId): string[] | null {
  const program = parseModuleProgram(code, id);
  if (program === null) return null; // unparseable — the caller reports it (`preserve` fixes it)
  const specs: string[] = [];
  const literalSource = (node: AnyNode | undefined): string | undefined =>
    node?.type === 'Literal' && typeof node.value === 'string' ? node.value : undefined;

  walk<null>(program, null, {
    ImportDeclaration(node, { next }) {
      const s = literalSource(node.source);
      if (s !== undefined) specs.push(s);
      next();
    },
    ExportNamedDeclaration(node, { next }) {
      const s = literalSource(node.source);
      if (s !== undefined) specs.push(s);
      next();
    },
    ExportAllDeclaration(node, { next }) {
      const s = literalSource(node.source);
      if (s !== undefined) specs.push(s);
      next();
    },
    ImportExpression(node, { next }) {
      // `import('./X.svelte')` — only a literal argument is statically resolvable.
      const s = literalSource(node.source);
      if (s !== undefined) specs.push(s);
      next();
    },
  });
  return specs;
}

/**
 * Scan `modules` for `.svelte`-resolving imports (docs §4.2).  Each module's static
 * specifiers are resolved with the SAME resolver the crawl uses (so a bare
 * `@ui/Button.svelte` resolves into `node_modules` just as it does from a `.svelte`
 * importer); a specifier resolving to a `.svelte` file marks that component escaped.
 * A module that cannot be read or parsed is collected into `unscannable` (NOT
 * silently dropped): a call site inside it is invisible, so the caller must warn.
 */
async function collectModuleEscapes(
  modules: ComponentId[],
  resolve: Resolve,
  readFile: ReadFile,
): Promise<{ escaped: Set<ComponentId>; unscannable: Set<ComponentId> }> {
  const escaped = new Set<ComponentId>();
  const unscannable = new Set<ComponentId>();
  for (const id of modules) {
    let code: string;
    try {
      code = await readFile(id);
    } catch {
      unscannable.add(id); // present on disk at scan time but unreadable now
      continue;
    }
    const specs = moduleImportSpecifiers(code, id);
    if (specs === null) {
      unscannable.add(id);
      continue;
    }
    for (const spec of specs) {
      const resolved = await resolve(spec, id);
      if (resolved && resolved.endsWith('.svelte')) escaped.add(resolved);
    }
  }
  return { escaped, unscannable };
}

/**
 * Partition user-declared `preserve` prefixes (docs §4.2) against a known component
 * set into the components they PRESERVE and the entries that matched NOTHING.  Each
 * entry is a Vite-root-relative or absolute path naming EITHER a component file
 * (exact match) OR a directory (every component under it) — the same "directory or
 * file prefix" basis as `entries`, with no glob dependency.  An entry matching no
 * component is almost always a typo / wrong path (or a missing `.svelte`
 * extension), so it is returned in `unmatched` for the caller to surface rather
 * than being a silent no-op that leaves the intended component unpreserved.
 */
function partitionPreserve(
  preserve: string[] | undefined,
  root: string,
  components: Iterable<ComponentId>,
): { matched: Set<ComponentId>; unmatched: string[] } {
  const matched = new Set<ComponentId>();
  const unmatched: string[] = [];
  if (!preserve || preserve.length === 0) return { matched, unmatched };
  const ids = [...components];
  for (const entry of preserve) {
    // `path.resolve` leaves an absolute entry as-is and resolves a relative one
    // against `root` — exactly "Vite-root-relative or absolute".
    const prefix = path.resolve(root, entry);
    const hits = ids.filter((id) => id === prefix || id.startsWith(prefix + path.sep));
    if (hits.length === 0) unmatched.push(entry);
    else for (const id of hits) matched.add(id);
  }
  return { matched, unmatched };
}

/** The components a set of `preserve` prefixes protects (docs §4.2).  The
 * {@link partitionPreserve} projection that drops the "matched nothing" diagnostic
 * — kept for callers that only need the ids. */
export function matchPreserve(
  preserve: string[] | undefined,
  root: string,
  components: Iterable<ComponentId>,
): ComponentId[] {
  return [...partitionPreserve(preserve, root, components).matched];
}

/**
 * The whole escape set for a build (docs §4.2), plus the diagnostics a Shell must
 * surface.  `escaped` is the union of components a non-`.svelte` module imports
 * (found by scanning) and those the user named via `preserve`.  `unscannable` are
 * modules the scan could not read/parse (a component mounted from one is NOT
 * escaped — the Shell warns and the user lists it in `preserve`); `unmatchedPreserve`
 * are `preserve` entries that matched no component (a typo leaves the intended
 * component unpreserved).  Returning them as data lets each Shell — the Vite plugin,
 * or a future `eslint-plugin-svelte` rule — report in its own voice.
 */
export interface EscapeScanResult {
  escaped: ComponentId[];
  unscannable: ComponentId[];
  unmatchedPreserve: string[];
}

/**
 * Compute the {@link EscapeScanResult} from "entry roots + resolver + component
 * set".  The one helper a Shell calls (the only escape-scan symbol re-exported from
 * `svelte-shaker/node`).
 */
export async function computeEscapedComponents(opts: {
  /**
   * Absolute crawl-entry roots (already resolved against the project root) — the
   * Vite plugin's `entries`.  The SAME roots drive two different walks: collecting
   * the `.svelte` crawl entries, and (here) collecting the non-`.svelte` modules to
   * scan for call sites that escape the component graph.
   */
  entryDirs: string[];
  /** Project root, for resolving relative `preserve` entries. */
  root: string;
  /** User-declared `preserve` prefixes (root-relative or absolute), if any. */
  preserve?: string[] | undefined;
  /** The crawled `.svelte` component ids, for matching `preserve` prefixes. */
  components: Iterable<ComponentId>;
  /**
   * Dev-only files to discount in the escape scan (docs §8.1.1) — the SAME predicate
   * the seed scan (`collectSvelteFiles`) applies, so a `Button.test.ts` neither seeds
   * a component nor escapes one.  Omitted, it defaults to {@link DEFAULT_DEV_ONLY}
   * matched relative to `root`.  Pass `compileDevOnly(root, [])` to scan everything.
   */
  devOnly?: DevOnlyFilter | undefined;
  resolve: Resolve;
  readFile: ReadFile;
}): Promise<EscapeScanResult> {
  const devOnly = opts.devOnly ?? compileDevOnly(opts.root);
  const modules: string[] = [];
  for (const dir of opts.entryDirs) collectNonSvelteModules(dir, devOnly, modules);
  const { escaped, unscannable } = await collectModuleEscapes(modules, opts.resolve, opts.readFile);
  const { matched, unmatched } = partitionPreserve(opts.preserve, opts.root, opts.components);
  for (const id of matched) escaped.add(id);
  return {
    escaped: [...escaped],
    unscannable: [...unscannable].sort(),
    unmatchedPreserve: unmatched,
  };
}
