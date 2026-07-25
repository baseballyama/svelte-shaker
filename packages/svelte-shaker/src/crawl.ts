/**
 * Component-graph crawl layer (the Shell-side resolution + IO half, docs
 * ARCHITECTURE §5/§6.1): BFS from `entries`, resolving every import edge and
 * reading each reachable `.svelte` into a batched {@link AnalyzeInput}. All IO
 * arrives through the injected `Resolve` / `ReadFile`, so this stays env-free and
 * ports to Rust as the resolution layer the engine ({@link analyzeInput}) consumes.
 */
import {
  parseCached,
  parseModuleProgram,
  walk,
  type AnyNode,
  type Parse,
  type ParseCache,
  type Root,
} from './parse.js';
import type { AnalyzeInput, ComponentId, InputFile, ResolvedEdge } from './ir.js';

export type Resolve = (
  source: string,
  importer: ComponentId,
) => Promise<ComponentId | null> | ComponentId | null;
export type ReadFile = (id: ComponentId) => Promise<string> | string;

const isSvelte = (source: string) => source.endsWith('.svelte');

export interface ImportInfo {
  value: string;
  local: string;
  /** `default` for a default import, the exported name for a named import, or
   * `*` for a namespace import. */
  imported: string;
}

export function* importSources(instance: AnyNode): Generator<ImportInfo> {
  const program = instance.content;
  for (const stmt of program?.body ?? []) {
    if (stmt.type !== 'ImportDeclaration') continue;
    const value = stmt.source?.value;
    if (typeof value !== 'string') continue;
    for (const spec of stmt.specifiers ?? []) {
      const local = spec.local?.name;
      if (!local) continue;
      if (spec.type === 'ImportDefaultSpecifier') yield { value, local, imported: 'default' };
      else if (spec.type === 'ImportNamespaceSpecifier') yield { value, local, imported: '*' };
      else if (spec.type === 'ImportSpecifier')
        // `import { Child as ChildB }` — `imported` is the source's export name.
        yield {
          value,
          local,
          // `import { Child as ChildB }` — `imported` is the source's export name,
          // falling back to `local` for shorthand `import { X }`.
          imported: specName(spec.imported) ?? local,
        };
    }
  }
}

/** The local/exported name strings of an Export/Import specifier. */
function specName(node: AnyNode | undefined): string | undefined {
  if (node?.type === 'Identifier' && node.name) return node.name;
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  return undefined;
}

/**
 * The three per-file facts the crawl needs to resolve edges — import specifiers,
 * rendered `<Local>` tag names, and `<ns.X>` member tag names. `null` when the file
 * has no instance script (nothing to attribute), matching the crawl's skip.
 */
export interface CrawlFacts {
  imports: ImportInfo[];
  renderedTags: Set<string>;
  memberTags: Set<string>;
}

/**
 * Source of {@link CrawlFacts} for one `(id, code)`. The default is a JS parse +
 * extraction ({@link jsCrawlFacts}); the native engine passes a provider backed by
 * `ShakeSession` facts, so the crawl resolves the SAME edges without the JS parse.
 */
export type FactsProvider = (id: ComponentId, code: string) => CrawlFacts | null;

/** The default facts provider: parse (svelte/compiler or rsvelte) and extract. */
export function jsCrawlFacts(
  id: ComponentId,
  code: string,
  parseCache?: ParseCache,
  parse?: Parse,
): CrawlFacts | null {
  const ast = parseCached(id, code, parseCache, parse);
  const instance = ast.instance;
  if (!instance) return null;
  return {
    imports: [...importSources(instance)],
    renderedTags: renderedComponentTagNames(ast),
    memberTags: memberComponentTags(ast),
  };
}

/**
 * The bare component tag names this file RENDERS (`<Local/>`, excluding dotted
 * `<ns.X/>` member tags). The Shell crawl uses this to resolve a barrel (a
 * `.js`/`.ts` re-export, which costs a module read+parse) only for named imports
 * actually rendered as a component — a value-only named import (a helper / type)
 * is never a `<Local>` call site, so following it would read+parse a module for
 * nothing. Skipping it only ever drops a non-call-site, so attribution (and the
 * resulting models) are unchanged.
 */
export function renderedComponentTagNames(ast: Root): Set<string> {
  const names = new Set<string>();
  walk<null>(ast.fragment, null, {
    Component(node, { next }) {
      if (typeof node.name === 'string' && node.name !== '' && !node.name.includes('.')) {
        names.add(node.name);
      }
      next();
    },
  });
  return names;
}

/**
 * Every dotted component tag a file renders (`<ns.Child/>` -> `"ns.Child"`).  The
 * Shell resolves each through its namespace import's barrel; bare `<Child/>` tags
 * have no dot and are bound by the plain import maps instead.
 */
export function memberComponentTags(ast: Root): Set<string> {
  const tags = new Set<string>();
  walk<null>(ast.fragment, null, {
    Component(node, { next }) {
      if (typeof node.name === 'string' && node.name.includes('.')) tags.add(node.name);
      next();
    },
  });
  return tags;
}

/** Cap on how many `.js`/`.ts` barrel hops we follow before giving up. */
const MAX_BARREL_HOPS = 8;

/**
 * Per-crawl memo of a `.js`/`.ts` barrel's parsed top-level body, keyed by its
 * resolved id.  A design-system `index.ts` is re-imported by hundreds of
 * components, and {@link resolveThroughBarrel} runs once per rendered call site,
 * so without this the SAME barrel is read + full-parsed hundreds of times.  The
 * body is never mutated (callers only read `export`/`import` statements off it),
 * so sharing one parse is behavior-preserving.  `null` caches an unreadable or
 * unparseable barrel so it is not retried.  Lives for one crawl only (a build is
 * one-shot; dev re-crawls fresh), so it never goes stale.
 */
type BarrelCache = Map<ComponentId, AnyNode[] | null>;

/**
 * The Shell-side resolution + IO layer (docs/RUST-MIGRATION.md §2.1): BFS-crawl
 * the component graph from `entries`, resolving every import edge and reading
 * every reachable `.svelte` file up front, into a batched {@link AnalyzeInput}.
 *
 * This is the half that STAYS in JS — it owns `this.resolve` / file IO for Vite
 * ecosystem compat (docs ARCHITECTURE §5/§9) — so the engine ({@link
 * analyzeInput}) consumes its output with no callback across the boundary.  The
 * traversal mirrors the old crawl exactly: direct default-`.svelte` children and
 * the barrel children a file actually RENDERS are followed (an unrendered barrel
 * import is never crawled — its `<Comp/>` site cannot exist, so it cannot taint a
 * value set), keeping the produced model set — and thus the output — identical.
 */
export async function buildAnalyzeInput(
  entries: ComponentId | ComponentId[],
  resolve: Resolve,
  readFile: ReadFile,
  parseCache?: ParseCache,
  parse?: Parse,
  escaped: ComponentId[] = [],
  // The facts source. Defaults to a JS parse + extract; the native engine injects a
  // `ShakeSession`-backed provider (docs M3). Internal — the public crawl is unchanged.
  factsProvider?: FactsProvider,
): Promise<AnalyzeInput> {
  const getFacts: FactsProvider =
    factsProvider ?? ((id, code) => jsCrawlFacts(id, code, parseCache, parse));
  const entryList = Array.isArray(entries) ? [...entries] : [entries];
  const files: InputFile[] = [];
  const edges: ResolvedEdge[] = [];
  const queue: ComponentId[] = [...entryList];
  const seen = new Set<ComponentId>(queue);
  // Parse each `.js`/`.ts` barrel at most once across the whole crawl (a shared
  // design-system `index.ts` is re-imported hundreds of times).
  const barrelCache: BarrelCache = new Map();

  while (queue.length > 0) {
    const id = queue.shift()!;
    const code = await readFile(id);
    files.push({ id, code });

    const facts = getFacts(id, code);
    if (!facts) continue;

    // The bare component tags this file renders (`<Local …>`). Resolving a barrel
    // (a `.js`/`.ts` re-export) means READING and PARSING the target module to
    // chase the export, so we do it ONLY for named imports actually rendered as a
    // component here — a named import used as a value (a helper / type) can never
    // be a `<Local>` call site, so chasing it is pure waste.
    const renderedTags = facts.renderedTags;

    // Resolve this file's imports into the three attributable edge kinds.  Direct
    // default `.svelte` and simple barrel/named imports bind a bare local; a
    // namespace import (`import * as ns`) binds no single component, so it is
    // deferred to its rendered `<ns.X>` member tags below.
    const barrelLocals = new Map<string, ComponentId>();
    const namespaceSources = new Map<string, string>();
    const directChildren: ComponentId[] = [];
    for (const imp of facts.imports) {
      if (imp.imported === '*') {
        namespaceSources.set(imp.local, imp.value);
        continue;
      }
      if (imp.imported === 'default' && isSvelte(imp.value)) {
        const childId = await resolve(imp.value, id);
        if (childId) {
          edges.push({ from: id, local: imp.local, to: childId, kind: 'default-svelte' });
          directChildren.push(childId);
        }
        continue;
      }
      // Not rendered as `<imp.local>` -> not a call site -> skip the costly barrel read.
      if (!renderedTags.has(imp.local)) continue;
      const childId = await resolveThroughBarrel(
        imp.value,
        imp.imported,
        id,
        resolve,
        readFile,
        barrelCache,
      );
      if (childId) {
        edges.push({ from: id, local: imp.local, to: childId, kind: 'barrel' });
        barrelLocals.set(imp.local, childId);
      }
    }

    // Namespace member renders (`<ns.X .../>`): resolve each `X` through the SAME
    // barrel logic a named `import { X } from '@ui'` uses, so a member tag is
    // attributed exactly when (and to the same component as) the equivalent named
    // import would be — its success/failure is correlated, which is what keeps
    // mixing the two forms sound.  The edge's `local` is the dotted tag the site
    // renders, so the engine attributes `<ns.X .../>` by name lookup.
    const nsChildren: ComponentId[] = [];
    if (namespaceSources.size > 0) {
      for (const tag of facts.memberTags) {
        const dot = tag.indexOf('.');
        const source = namespaceSources.get(tag.slice(0, dot));
        if (source == null) continue;
        const childId = await resolveThroughBarrel(
          source,
          tag.slice(dot + 1),
          id,
          resolve,
          readFile,
          barrelCache,
        );
        if (childId) {
          edges.push({ from: id, local: tag, to: childId, kind: 'namespace' });
          nsChildren.push(childId);
        }
      }
    }

    // Enqueue every child this file renders: direct `.svelte`, the barrel children
    // it renders (`barrelLocals` already holds only rendered locals), and the
    // namespace members it renders.
    for (const childId of [...directChildren, ...barrelLocals.values(), ...nsChildren]) {
      if (!seen.has(childId)) {
        seen.add(childId);
        queue.push(childId);
      }
    }
  }

  return { files, edges, entries: entryList, escaped };
}

/**
 * Follow a NON-direct import (named / namespace, or a default import of a
 * `.js`/`.ts` barrel) to the `.svelte` component it ultimately renders, if any.
 *
 * The dangerous case (docs §4.2): a child reached BOTH directly and through a
 * barrel re-export — `import { Child } from './lib.js'` where `lib.js` is
 * `export { default as Child } from './Child.svelte'`.  The `<Child/>` site in
 * the barrel-consuming file is invisible to {@link collectChildCalls}, so the
 * child's value set would omit it and fold unsoundly.  We resolve through the
 * barrel here so `analyze` can bail that child.  When the source resolves to a
 * `.svelte` default we return it; through a `.js`/`.ts` we read the module and
 * follow `export … from`, `export *`, and re-exported local imports.  Anything
 * we cannot follow returns `null` — sound, because a child we never resolve is
 * never planned (a pure-barrel `.js` component is simply out of scope).
 */
async function resolveThroughBarrel(
  source: string,
  imported: string,
  importer: ComponentId,
  resolve: Resolve,
  readFile: ReadFile,
  cache: BarrelCache,
  hops = 0,
): Promise<ComponentId | null> {
  if (hops > MAX_BARREL_HOPS) return null;
  const targetId = await resolve(source, importer);
  if (!targetId) return null;

  // A `.svelte` reached by default (or namespace, whose `.default` is the
  // component) renders that component.  A NAMED import of a `.svelte` cannot name
  // a component (`.svelte` only exports `default`), so it never renders one.
  if (isSvelte(source) || isSvelte(targetId)) {
    return imported === 'default' || imported === '*' ? targetId : null;
  }

  // A `.js`/`.ts` barrel: read + parse it (once per crawl, memoized) and chase the
  // matching re-export.
  let body = cache.get(targetId);
  if (body === undefined) {
    let code: string | null;
    try {
      code = await readFile(targetId);
    } catch {
      code = null;
    }
    body = code === null ? null : parseModuleBody(code, targetId);
    cache.set(targetId, body);
  }
  if (!body) return null;

  for (const stmt of body) {
    // `export { local as exported } from './x'`  /  `export { default } from`.
    if (stmt.type === 'ExportNamedDeclaration' && stmt.source?.value) {
      for (const spec of stmt.specifiers ?? []) {
        if (specName(spec.exported) !== imported) continue;
        return resolveThroughBarrel(
          String(stmt.source.value),
          specName(spec.local) ?? 'default',
          targetId,
          resolve,
          readFile,
          cache,
          hops + 1,
        );
      }
      continue;
    }
    // `export { D as Child }` (no `from`) — re-export of a LOCAL import binding.
    if (stmt.type === 'ExportNamedDeclaration' && !stmt.source) {
      for (const spec of stmt.specifiers ?? []) {
        if (specName(spec.exported) !== imported) continue;
        const localName = specName(spec.local);
        if (!localName) continue;
        const found = followLocalImport(body, localName);
        if (!found) return null;
        return resolveThroughBarrel(
          found.value,
          found.imported,
          targetId,
          resolve,
          readFile,
          cache,
          hops + 1,
        );
      }
      continue;
    }
    // `export * from './x'` — the name may live behind the wildcard.
    if (stmt.type === 'ExportAllDeclaration' && stmt.source?.value) {
      const via = await resolveThroughBarrel(
        String(stmt.source.value),
        imported,
        targetId,
        resolve,
        readFile,
        cache,
        hops + 1,
      );
      if (via) return via;
    }
  }
  return null;
}

/** Find the import in `body` that binds `localName`, as an {@link ImportInfo}. */
function followLocalImport(
  body: AnyNode[],
  localName: string,
): { value: string; imported: string } | null {
  for (const stmt of body) {
    if (stmt.type !== 'ImportDeclaration') continue;
    const value = stmt.source?.value;
    if (typeof value !== 'string') continue;
    for (const spec of stmt.specifiers ?? []) {
      if (spec.local?.name !== localName) continue;
      if (spec.type === 'ImportDefaultSpecifier') return { value, imported: 'default' };
      if (spec.type === 'ImportNamespaceSpecifier') return { value, imported: '*' };
      if (spec.type === 'ImportSpecifier')
        return { value, imported: specName(spec.imported) ?? localName };
    }
  }
  return null;
}

/**
 * Parse a `.js`/`.ts` barrel's top-level body via {@link parseModuleProgram}
 * (the engine has no standalone JS parser; the shared helper wraps the source in
 * a `<script module lang="ts">` so TypeScript barrels — `export type { … }`,
 * type-only specifiers — parse, and neutralizes any `</script>` in the text so a
 * valid module that merely mentions it still parses, issue #146).  Returns `null`
 * if it cannot be parsed — callers then leave the barrel unfollowed.
 */
function parseModuleBody(code: string, id: ComponentId): AnyNode[] | null {
  return parseModuleProgram(code, id)?.body ?? null;
}
