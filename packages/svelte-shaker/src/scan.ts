// ----------------------------------------------------------------------
// Node-only Shell glue (docs/ARCHITECTURE.md §5).  Kept OUT of `index.ts` so the
// engine core has no `node:*` imports and runs unchanged in the browser.
// Exposed to Node consumers via the `svelte-shaker/node` entry point.
// ----------------------------------------------------------------------
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseSvelte, walk, type AnyNode } from './parse.js';
import type { ComponentId } from './ir.js';
import type { Resolve, ReadFile } from './analyze.js';

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
 * `node_modules` and dot-directories, mirroring {@link collectSvelteFiles}).  The
 * Shell feeds these to {@link collectExternalEscapes} to find components used from
 * outside the `.svelte` graph.  Same include scope as the seed scan — `.ts` inside
 * `node_modules` is deliberately NOT scanned (docs §4.2).
 */
export function collectNonSvelteModules(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectNonSvelteModules(full));
    else if (entry.isFile() && isScannableModule(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Every module specifier a JS/TS module statically references: `import … from`,
 * `export … from` / `export *`, and a dynamic `import('…')` whose argument is a
 * STRING LITERAL.  A computed dynamic import (`import(expr)`) is unknowable here —
 * the `external` option (docs §4.2) is the sound fallback for it.  Parsed via the
 * Svelte parser's `<script module lang="ts">` wrapper (the same TS-capable parse
 * the engine's barrel-following uses); an unparseable module yields no specifiers,
 * so it is simply not followed.
 */
function moduleImportSpecifiers(code: string, id: ComponentId): string[] {
  let module: AnyNode | null | undefined;
  try {
    module = parseSvelte(`<script module lang="ts">\n${code}\n</script>`, id).module;
  } catch {
    return [];
  }
  const program = module?.content;
  if (!program) return [];
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
 * Given the non-`.svelte` modules under the include roots, return every `.svelte`
 * component id one of them imports (docs §4.2, {@link
 * import('./ir.js').AnalyzeInput.escaped}).  Each module's static specifiers are
 * resolved with the SAME resolver the crawl uses (so a bare `@ui/Button.svelte`
 * resolves into `node_modules` just as it does from a `.svelte` importer); a
 * specifier resolving to a `.svelte` file marks that component escaped.  A module
 * that cannot be read or parsed contributes nothing (best-effort — `external` is
 * the sound fallback for what the scan misses).
 */
export async function collectExternalEscapes(
  modules: ComponentId[],
  resolve: Resolve,
  readFile: ReadFile,
): Promise<Set<ComponentId>> {
  const escaped = new Set<ComponentId>();
  for (const id of modules) {
    let code: string;
    try {
      code = await readFile(id);
    } catch {
      continue;
    }
    for (const spec of moduleImportSpecifiers(code, id)) {
      const resolved = await resolve(spec, id);
      if (resolved && resolved.endsWith('.svelte')) escaped.add(resolved);
    }
  }
  return escaped;
}

/**
 * Expand user-declared `external` prefixes (docs §4.2) against a known component
 * set.  Each entry is a Vite-root-relative or absolute path naming EITHER a
 * component file (exact match) OR a directory (every component under it) — the
 * same "directory or file prefix" basis as `include`, with no glob dependency.  A
 * matched component is returned so the caller can escape it: the file STAYS in the
 * analysis (its own call sites keep counting toward its children), only itself is
 * frozen — never a filter that drops it from the scan.  An entry matching nothing
 * is a harmless no-op.
 */
export function matchExternal(
  external: string[] | undefined,
  root: string,
  components: Iterable<ComponentId>,
): ComponentId[] {
  if (!external || external.length === 0) return [];
  // `path.resolve` leaves an absolute entry as-is and resolves a relative one
  // against `root` — exactly "Vite-root-relative or absolute".
  const prefixes = external.map((p) => path.resolve(root, p));
  const out: ComponentId[] = [];
  for (const id of components) {
    if (prefixes.some((p) => id === p || id.startsWith(p + path.sep))) out.push(id);
  }
  return out;
}

/**
 * The whole escape set (docs §4.2) for a build: components used from a
 * non-`.svelte` module (found by scanning {@link collectNonSvelteModules} with
 * {@link collectExternalEscapes}) UNIONED with those the user named via `external`
 * ({@link matchExternal}).  This is the one helper a Shell — the Vite plugin, or a
 * future `eslint-plugin-svelte` rule — calls to turn "include roots + resolver +
 * component set" into the `AnalyzeInput.escaped` ids the engine bails.
 */
export async function computeEscapedComponents(opts: {
  /** Absolute include roots (already resolved against the project root). */
  includeDirs: string[];
  /** Project root, for resolving relative `external` entries. */
  root: string;
  /** User-declared `external` prefixes (root-relative or absolute), if any. */
  external?: string[] | undefined;
  /** The crawled `.svelte` component ids, for matching `external` prefixes. */
  components: Iterable<ComponentId>;
  resolve: Resolve;
  readFile: ReadFile;
}): Promise<ComponentId[]> {
  const escaped = await collectExternalEscapes(
    opts.includeDirs.flatMap(collectNonSvelteModules),
    opts.resolve,
    opts.readFile,
  );
  for (const id of matchExternal(opts.external, opts.root, opts.components)) escaped.add(id);
  return [...escaped];
}
