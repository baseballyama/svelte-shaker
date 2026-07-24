import * as fs from 'node:fs';
import * as path from 'node:path';
import { compile } from 'svelte/compiler';
import type { Plugin } from 'vite';
import { svelteShaker, svelteShakerWithMono, type Parse, type Resolve } from './index.js';
import { DevShaker, type DevMode } from './engine.js';
import { collectSvelteFiles, fsResolve } from './scan.js';
import {
  computeEscapedComponents,
  isScannableModule,
  type EscapeScanResult,
} from './escape-scan.js';
import { compileDevOnly } from './dev-only.js';
import { compileExclude, type ExcludeFilter } from './exclude.js';

// Re-export so a user can extend the default dev-only list: `devOnly: [...DEFAULT_DEV_ONLY, '…']`.
export { DEFAULT_DEV_ONLY } from './dev-only.js';
import { DEFAULT_MONO_OPTIONS, type MonomorphizeOptions, type OwnSize } from './mono.js';
import { tryLoadRsvelteParser, tryLoadRsvelteOwnSize } from './rsvelte-parse.js';
import { svelteShakerWasm, svelteShakerWasmWithMono, tryLoadWasmEngine } from './wasm-engine.js';
import { svelteShakerNativeWithMono, tryLoadNativeEngine } from './native-engine.js';
import type { ComponentId } from './ir.js';

/**
 * Options for the {@link shaker} plugin.  The set below is exhaustive: any other
 * key throws at build start rather than being ignored, because an option we never
 * read is an option the user thinks is applied and is not.
 */
export interface ShakerOptions {
  /**
   * Directories (relative to the Vite root) the component crawl STARTS from —
   * the same semantics as SvelteKit's `config.kit.prerender.entries`: you list
   * the roots, and everything reachable from them is pulled in by following the
   * import graph.  Defaults to the Vite root itself.  No glob: each entry is a
   * directory (or a single component file), matched on a plain path-prefix basis.
   *
   * This is NOT an include filter, and it does not bound what gets rewritten: a
   * library component in `node_modules` is never under an entry root, yet it is
   * still crawled and shaken, because a component that IS under one imports it.
   *
   * The soundness contract runs the other way.  Every `.svelte` file found is
   * treated as a call-site source, so the union of these roots must cover EVERY
   * call site in the app (docs/ARCHITECTURE.md §4.2).  Narrowing `entries` to a
   * subset of the app does not shake less — it hides call sites, and a prop the
   * shaker cannot see being passed is folded away.
   */
  entries?: string[];
  /**
   * Components whose PROP INTERFACE must be left exactly as written, because they
   * have a consumer the shake cannot see (docs/ARCHITECTURE.md §4.2).  Each entry
   * is a Vite-root-relative or absolute path naming EITHER a component file or a
   * directory of them — the same "directory or file prefix" basis as
   * {@link entries}, no glob.
   *
   * What is preserved is the prop interface, NOT the component's presence in the
   * bundle: this is unrelated to Rollup/Vite's `external`, and it never keeps a
   * file out of the bundle or out of the analysis.
   *
   * Reach for it when a consumer lives outside the `.svelte` graph and the shaker
   * cannot observe that call site: a `mount()` behind a NON-literal dynamic
   * `import(expr)`, or a module outside the {@link entries} roots.  Consumers
   * reached by a static `.ts`/`.js` import are already found by the non-`.svelte`
   * module scan, so those need no entry here.
   *
   * A-semantics — listing a component does NOT exclude it from the scan: the file
   * stays fully in the analysis (its own `<Child/>` call sites keep counting toward
   * its children's profiles), and only the component ITSELF has its prop folding /
   * never-passed reporting turned off.  It is not a way to make the shaker ignore
   * a file.
   *
   * Over-listing errs SAFE, the opposite of {@link entries}: a component preserved
   * without needing it is merely shaken less, never wrongly.
   */
  preserve?: string[];
  /**
   * Glob patterns naming files that are DEV-ONLY — they never ship in the production
   * bundle (colocated tests, mocks, Storybook stories), so their call sites must not
   * count toward the shake.  A matched file stops counting as a component consumer in
   * BOTH directory scans (the `.svelte` seed scan and the non-`.svelte` escape scan);
   * patterns are matched with `picomatch` against the posix-normalized path relative
   * to the Vite root.  Defaults to {@link DEFAULT_DEV_ONLY}.
   *
   * List ONLY files that never ship: the option declares a property of the files,
   * which is exactly the soundness contract that makes discounting them safe.  A
   * matched file is NOT excluded from the shake — a dev-only `.svelte` file the app
   * actually imports is still crawled and shaken through the normal import graph, so
   * its genuine app call sites still count.  This only removes it as a SEED / ESCAPE
   * source; it cannot un-cover reachable app code.
   *
   * The failure mode to avoid: a matched file's call sites simply STOP COUNTING.  So
   * if a file that really ships matches a pattern — a `+page.svelte` under a route
   * dir named `__tests__`, a `foo.test.utils.ts` that mounts a component — the
   * distinct prop values it passes no longer block a fold, exactly as if you had left
   * it out of {@link entries}.  That is why the defaults are narrow, convention-based
   * patterns rather than an open glob (see docs/ARCHITECTURE.md §8.1.1).  It is
   * unrelated to {@link preserve}: that keeps a shipping component's props as written;
   * this declares that a file is not part of the production graph at all.
   *
   * Passing `devOnly` REPLACES the default rather than adding to it (predictable
   * semantics); extend it with `[...DEFAULT_DEV_ONLY, '…']`, and pass `devOnly: []` to
   * count every file (the pre-`devOnly` behavior).
   */
  devOnly?: string[];
  /**
   * Build-output directories the scans must NOT walk (docs/ARCHITECTURE.md §8.1.1) —
   * a compiled/generated tree that is not source: a SvelteKit adapter's `build/`,
   * a `dist/`, any prior build artifact.  Each entry is a Vite-root-relative or
   * absolute path naming a directory, matched on a plain path-prefix basis — the
   * same "directory prefix" basis as {@link entries}, no glob.
   *
   * The resolved Vite `build.outDir` is ALWAYS excluded automatically (it is the
   * destination this build overwrites, so it can hold no source the app depends
   * on); this option is for output dirs the plugin cannot infer — most importantly
   * a SvelteKit adapter's `build/`, which sits outside `build.outDir`. Excluding it
   * skips parsing megabytes of minified output the escape scan would otherwise read
   * (issue: adapter-static `build/` dominated the crawl).
   *
   * Distinct from {@link devOnly}: `devOnly` marks non-shipping SOURCE files (tests,
   * stories) by glob; `exclude` prunes whole generated-OUTPUT directories that are
   * not source at all. Like {@link entries}, over-listing errs UNSAFE — a pruned
   * directory's call sites stop counting, exactly as if it were outside the crawl —
   * so name ONLY generated output, never source. That is why there is no default
   * beyond the always-safe `build.outDir`.
   */
  exclude?: string[];
  /**
   * Per-call-site monomorphization tuning (docs §13.2).  Monomorphization is ON
   * by default because it is bail-safe and never bloats (the measured net-win
   * gate, docs §3).  `true`/omitted enables it with defaults; an object overrides
   * `maxVariants` / `minSavings`; `false` is the ONLY way to turn it OFF, e.g. to
   * trade a little compression for faster builds.  Raising `maxVariants` lets
   * children with more distinct call-site shapes be specialized — affordable now
   * that the net-win gate only sizes the modules that actually differ (docs §13.2).
   * The always-on passes (unused-prop fold / constant fold / value-set narrowing)
   * have no switch: they are bail-safe and never grow the output.
   */
  monomorphize?: boolean | Partial<Omit<MonomorphizeOptions, 'enabled'>>;
  /**
   * Which engine runs the whole shake (analysis + transform, including
   * monomorphization).  Default `'auto'`.  There are two Rust engines — the same
   * analysis behind two frontends — plus the JS engine:
   *  - the NATIVE (napi) engine parses with rsvelte IN PROCESS and keeps the ASTs
   *    Rust-side, so no whole-program AST crosses a boundary. It is the fastest and
   *    has no size ceiling, but ships as a per-platform prebuilt binary that may not
   *    exist for every install;
   *  - the WASM engine is the same Rust engine, but the whole-program AST must cross
   *    the JS<->WASM boundary as JSON — tens of MB past a few hundred components — so
   *    it only wins for small/medium apps;
   *  - the JS engine needs no boundary crossing at all, so it wins for a large app
   *    when the native engine isn't available.
   *
   *  - `'auto'` — the native engine if a binary loads (no size gate); otherwise the
   *    WASM engine for a small/medium app, or the JS engine for a large one.
   *  - `'rust'` — force a Rust engine: native if it loads, else WASM; throws if
   *    neither can be loaded.
   *  - `'js'` — force the JS engine.
   * All three are differentially tested to produce byte-identical output, so the
   * choice only affects speed, never what is shaken.
   */
  engine?: 'auto' | 'js' | 'rust';
  /**
   * Whether to shake in `vite dev` too (docs/RUST-MIGRATION.md §3 M2,
   * ARCHITECTURE §6.2).  Default `false` — dev is a pass-through, which is always
   * correct and keeps HMR simple.  Opt in to incremental dev shaking with:
   *  - `'incremental'` — re-parses only changed files, re-runs the whole-program
   *    fixpoint over a long-lived {@link DevShaker} (fast, the intended mode);
   *  - `'coarse'` — re-analyzes the whole program on every change (the slow but
   *    trivially-correct safety valve).
   * Monomorphization is NOT applied in dev (unused-prop fold / constant fold /
   * value-set narrowing only — docs §5 risks).
   */
  dev?: false | DevMode;
  /**
   * How the JS / WASM engines parse `.svelte`.  Does NOT apply to the native engine,
   * which always parses with rsvelte IN PROCESS (there is no JS-side parse to pick).
   * Defaults to FOLLOW THE ENGINE: `'rsvelte'` on the WASM engine — its AST crosses
   * the boundary directly — and `'svelte'` (svelte/compiler) on the JS engine, where
   * rsvelte's parse is pure overhead (~2x slower) with no downstream benefit.  The
   * JS-side rsvelte parser loads from `@rsvelte/compiler` (a bundled WASM dependency —
   * nothing extra to install, no platform-specific binary).
   *
   * The engine reads only UTF-16 `start`/`end`, never `loc`, so the choice can never
   * affect what renders — it is soundness-neutral, differentially tested to produce
   * byte-identical output either way.  `parser: 'svelte'` also forces the native
   * engine OFF (it cannot honor svelte/compiler), so the shake uses a JS/WASM engine
   * that parses with svelte/compiler.  When rsvelte IS the resolved JS-side parser (an
   * explicit `parser: 'rsvelte'`, or the WASM engine's default) and `@rsvelte/compiler`
   * can't be loaded, the plugin THROWS rather than silently swapping to svelte/compiler,
   * so the same source can't shake differently on another machine: set
   * `parser: 'svelte'` to opt out.
   */
  parser?: 'svelte' | 'rsvelte';
  /**
   * Report how much the shake saved.  Default `false`: a single one-line summary
   * of the whole-program byte reduction is always printed after the build crawl.
   * `true` additionally prints a per-file breakdown (original → shaken size and
   * the delta) for every component that actually shrank, so you can see which
   * files were shaken and by how much.  Reporting only — it never affects output.
   */
  verbose?: boolean;
}

/** A component that the shake actually shrank, with its before/after byte size. */
interface SizeRow {
  id: ComponentId;
  before: number;
  after: number;
}

/** kB with two decimals, the unit Vite itself uses in its build size report. */
function formatKB(bytes: number): string {
  return `${(bytes / 1024).toFixed(2)} kB`;
}

/**
 * Compiled-output size proxy: the bytes the Svelte compiler emits for `code`
 * (client JS + scoped CSS).  This is the number that actually ships, so it
 * captures what the SOURCE-byte total cannot: a dead `{#if}` arm or a removed
 * `<style>` rule shrinks the compiled output far more than its few source bytes
 * suggest.  Reporting-only; `null` if the (always valid) source fails to compile,
 * so the caller can skip it without aborting the build.
 */
function compiledSize(code: string, id: ComponentId): number | null {
  try {
    const { js, css } = compile(code, { generate: 'client', dev: false, filename: id });
    return js.code.length + (css?.code.length ?? 0);
  } catch {
    return null;
  }
}

/**
 * Print what the shake saved.  Always emits a one-line whole-program summary;
 * when `verbose`, also lists each shrunk file (largest saving first).  Sizes are
 * UTF-8 byte lengths of the source the engine consumed vs. produced — the honest
 * "how much smaller is the source we hand to the Svelte compiler" number, not the
 * final post-compile/minify bundle size.
 */
function reportSizes(
  shaken: Record<ComponentId, string>,
  read: (id: ComponentId) => string,
  root: string,
  verbose: boolean,
  log: (msg: string) => void,
): void {
  let totalBefore = 0;
  let totalAfter = 0;
  const rows: SizeRow[] = [];
  for (const [id, after] of Object.entries(shaken)) {
    const beforeBytes = Buffer.byteLength(read(id));
    const afterBytes = Buffer.byteLength(after);
    totalBefore += beforeBytes;
    totalAfter += afterBytes;
    if (afterBytes < beforeBytes) rows.push({ id, before: beforeBytes, after: afterBytes });
  }
  if (totalBefore === 0) return;

  const saved = totalBefore - totalAfter;
  const pct = ((saved / totalBefore) * 100).toFixed(1);
  log(
    `shaken ${rows.length}/${Object.keys(shaken).length} files: ` +
      `${formatKB(totalBefore)} → ${formatKB(totalAfter)} ` +
      `(saved ${formatKB(saved)}, ${pct}%)`,
  );

  if (!verbose) return;
  for (const row of rows.sort((a, b) => b.before - b.after - (a.before - a.after))) {
    const rel = path.relative(root, row.id) || row.id;
    const fileSaved = row.before - row.after;
    const filePct = ((fileSaved / row.before) * 100).toFixed(1);
    log(`  ${rel}: ${formatKB(row.before)} → ${formatKB(row.after)} (-${filePct}%)`);
  }

  // The source-byte delta UNDER-reports the real win: a folded dead branch or a
  // removed `<style>` rule shrinks the compiled output much more than its source.
  // Compiling is costly, so we only do it for the files that actually shrank, and
  // only under `verbose` — it never affects the build, just the visible number.
  let compiledBefore = 0;
  let compiledAfter = 0;
  for (const row of rows) {
    const before = compiledSize(read(row.id), row.id);
    const after = compiledSize(shaken[row.id]!, row.id);
    if (before === null || after === null) continue; // skip the un-compilable
    compiledBefore += before;
    compiledAfter += after;
  }
  if (compiledBefore > 0) {
    const compiledSaved = compiledBefore - compiledAfter;
    const compiledPct = ((compiledSaved / compiledBefore) * 100).toFixed(1);
    log(
      `compiled output (js+css) of shaken files: ` +
        `${formatKB(compiledBefore)} → ${formatKB(compiledAfter)} ` +
        `(saved ${formatKB(compiledSaved)}, ${compiledPct}%)`,
    );
  }
}

/** Query flag a specialized-variant `.svelte` request carries (see below). */
const VARIANT_QUERY = 'shaker_variant';

/**
 * Above this many seed components, `auto` uses the JS engine instead of the native
 * one.  The native engine's parse is faster, but it marshals the whole-program AST
 * across the JS<->WASM boundary as JSON; for a large app (hundreds of components,
 * tens of MB of AST) that round-trip outweighs the parse saving, so the
 * boundary-free JS engine wins.  A round proxy for "the AST is big enough that the
 * boundary tax dominates", not a measured knife-edge — the choice is speed-only
 * (both engines emit byte-identical output), so being approximate is fine.
 */
const RUST_ENGINE_MAX_COMPONENTS = 300;

/**
 * Resolve the {@link MonomorphizeOptions} from the public option surface.
 * Monomorphization is ON by default (it is bail-safe and never bloats); it is
 * disabled only by an explicit `monomorphize: false`.  An object `monomorphize`
 * overrides the tuning knobs (`maxVariants` / `minSavings`).
 */
function resolveMono(options: ShakerOptions): MonomorphizeOptions {
  if (options.monomorphize === false) return DEFAULT_MONO_OPTIONS;
  const overrides = typeof options.monomorphize === 'object' ? options.monomorphize : {};
  return { ...DEFAULT_MONO_OPTIONS, enabled: true, ...overrides };
}

/**
 * Options renamed in the pre-1.0 cleanup: stale key -> what to write instead and
 * why the old name described the wrong thing.  Both renames dropped a name the
 * ecosystem had already spent on a DIFFERENT meaning, so the message has to say
 * more than "renamed" — a user who reaches for the old key is usually carrying
 * the old key's ecosystem meaning with it.
 */
const RENAMED_OPTIONS: Record<string, string> = {
  include:
    'the "include" option was renamed to "entries": rename `include:` to `entries:`. It was ' +
    'never a file filter — it lists the directories the component crawl STARTS from, and ' +
    'everything reachable from them (including library components under node_modules) is ' +
    'shaken whether or not it sits under one.',
  external:
    'the "external" option was renamed to "preserve": rename `external:` to `preserve:`. It ' +
    'has nothing to do with Rollup/Vite `external` — it never keeps a file out of the bundle. ' +
    'It names components whose prop interface must be left as written because a consumer the ' +
    'shaker cannot see (a non-literal dynamic `import(expr)`, a module outside `entries`) ' +
    'passes props to them.',
};

/**
 * Every key {@link ShakerOptions} accepts.  The `satisfies` is the point of the
 * table: adding an option to the interface without listing it here fails
 * `tsc --noEmit`, so the accept-list can never drift behind the type and start
 * rejecting a valid config.
 */
const KNOWN_OPTIONS = {
  entries: true,
  preserve: true,
  devOnly: true,
  exclude: true,
  monomorphize: true,
  engine: true,
  dev: true,
  parser: true,
  verbose: true,
} satisfies Record<keyof ShakerOptions, true>;

/**
 * Reject anything that is not an option we act on.  A Vite config is external
 * input, so this is a boundary check, not a courtesy: an ignored key still
 * builds, but what the user configured quietly does not apply — `entries` falls
 * back to the Vite root, `preserve` to an empty set, and that last one ships an
 * over-shaken component.
 *
 * A typo (`preserv:`) fails in exactly that way, which is why unknown keys are
 * rejected on the same footing as the pre-rename keys ({@link RENAMED_OPTIONS})
 * rather than only the ones we happen to have a migration note for.  TypeScript's
 * excess-property check only fires on an object literal written inline, so a
 * config built up in a variable — or any JS config — reaches us unguarded.
 */
function assertValidOptions(options: ShakerOptions): void {
  for (const key of Object.keys(options)) {
    if (Object.hasOwn(RENAMED_OPTIONS, key))
      throw new Error(`[vite-plugin-svelte-shaker] ${RENAMED_OPTIONS[key]}`);
    if (!Object.hasOwn(KNOWN_OPTIONS, key))
      throw new Error(
        `[vite-plugin-svelte-shaker] unknown option "${key}". Valid options are: ` +
          `${Object.keys(KNOWN_OPTIONS).join(', ')}. Check the spelling — an option we ` +
          `do not read is an option that does not apply.`,
      );
  }
}

/**
 * Source-level Svelte tree-shaking as a Vite plugin (docs/ARCHITECTURE.md §6).
 *
 * Build-only by default: dev is a pass-through unless `dev` is set (§6.2), so
 * `apply` returns true in build always and in serve only when opted in.  When
 * `dev` is enabled, `configureServer` drives a long-lived incremental
 * {@link DevShaker} and `handleHotUpdate` widens the HMR boundary to the children
 * whose residual changed (docs/RUST-MIGRATION.md §3 M2).  `enforce: 'pre'` runs
 * us before `@sveltejs/vite-plugin-svelte` in both modes, so we hand it
 * already-slimmed `.svelte` source and stay decoupled from Svelte's codegen.
 *
 * Monomorphization wiring: a specialized variant is exposed as a request
 * for the ORIGINAL child file with a `?shaker_variant=<id>` query.  Keeping the
 * real `.svelte` path means the variant's own relative imports (`./Icon.svelte`)
 * resolve exactly as they would in the unspecialized child, and vite-plugin-svelte
 * still compiles it as a normal component; our `transform` swaps in the variant
 * residual for that id.  Two call sites with byte-identical residuals share one
 * variant id (dedup), so they share one compiled module.
 */
export function shaker(options: ShakerOptions = {}): Plugin {
  assertValidOptions(options);
  const mono = resolveMono(options);
  let shaken: Record<ComponentId, string> = {};
  /** Variant request id (`<childPath>?shaker_variant=<n>`) -> residual source. */
  let variantSources = new Map<string, string>();
  let root = process.cwd();
  // Build-output dirs pruned from both scans (docs §8.1.1): the resolved
  // `build.outDir` (when safe) plus the user's `exclude`.  Compiled in
  // `configResolved`, once `build.outDir` is known.
  let exclude: ExcludeFilter = compileExclude(root, options.exclude);
  // Vite's logger, captured in `configResolved`; until then fall back to console
  // so the size report still surfaces if `buildStart` somehow runs first.
  let log: (msg: string) => void = (msg) => console.info(`[svelte-shaker] ${msg}`);
  let warn: (msg: string) => void = (msg) => console.warn(`[svelte-shaker] ${msg}`);

  // Surface the escape scan's diagnostics (docs §4.2) as build warnings: modules the
  // scan could not parse (a component mounted from one is left unpreserved — a real
  // soundness hole), and `preserve` entries that matched no component (a typo leaves
  // the intended component unpreserved).  Both are actionable and name the offenders,
  // but never fail the build — the shake is still emitted.
  const reportEscapeDiagnostics = (result: EscapeScanResult): void => {
    if (result.unscannable.length > 0) {
      warn(
        `could not parse ${result.unscannable.length} non-\`.svelte\` module(s), so any ` +
          `component mounted from one of them is invisible to the shake and may be ` +
          `over-shaken (props it is really passed folded away). If any of these mounts a ` +
          `component, list that component in the \`preserve\` option to keep its props:\n` +
          result.unscannable.map((f) => `  - ${path.relative(root, f) || f}`).join('\n'),
      );
    }
    if (result.unmatchedPreserve.length > 0) {
      warn(
        `\`preserve\` matched no component for ${result.unmatchedPreserve.length} entr` +
          `${result.unmatchedPreserve.length === 1 ? 'y' : 'ies'} (check the path, and that a ` +
          `file entry keeps its \`.svelte\` extension); the intended component is NOT ` +
          `preserved, so its props can still be folded:\n` +
          result.unmatchedPreserve.map((e) => `  - ${e}`).join('\n'),
      );
    }
  };

  // Dev (serve) shaking is opt-in (docs §6.2); `null` keeps dev a pass-through.
  const devMode: DevMode | null =
    options.dev === 'coarse' || options.dev === 'incremental' ? options.dev : null;
  /** The long-lived incremental engine, created in `configureServer` (serve only). */
  let devShaker: DevShaker | null = null;

  // Resolve the parser ONCE (lazily, so the rsvelte wasm is only loaded when a
  // parser is actually needed).  `undefined` means svelte/compiler.
  //
  // The default FOLLOWS THE ENGINE: rsvelte feeds the native (Rust) engine — its
  // AST crosses the WASM boundary directly — but on the JS engine rsvelte's parse
  // is pure overhead (~2x slower than svelte/compiler here) with no downstream
  // benefit, so the JS path defaults to svelte/compiler.  The two parsers are
  // differentially tested to produce byte-identical output, so this is speed-only.
  //
  // When rsvelte IS the resolved parser (the native engine, or explicit
  // `parser: 'rsvelte'`) and `@rsvelte/compiler` can't be loaded, the plugin THROWS
  // rather than silently swapping to svelte/compiler — a silent swap would make the
  // same source shake on one machine and not another. `parser: 'svelte'` is the
  // explicit opt-out; `parser: 'rsvelte'` forces rsvelte even on the JS engine.
  // Memoized PER ENGINE: `vite build --watch` reuses this plugin instance across
  // rebuilds, and `auto` can flip engine as the app grows/shrinks past the size
  // threshold — so the parser must be able to follow.  Keyed by `useRust` (a
  // present key is a resolved slot, whose value may legitimately be `undefined` =
  // svelte/compiler).
  const parseByEngine = new Map<boolean, Parse | undefined>();
  const getParse = (useRust: boolean): Parse | undefined => {
    if (parseByEngine.has(useRust)) return parseByEngine.get(useRust);
    const parser = options.parser ?? (useRust ? 'rsvelte' : 'svelte');
    let resolved: Parse | undefined;
    if (parser === 'rsvelte') {
      resolved = tryLoadRsvelteParser() ?? undefined;
      if (!resolved)
        throw new Error(
          '[vite-plugin-svelte-shaker] the "rsvelte" parser could not load its ' +
            'bundled dependency `@rsvelte/compiler` (a broken install, or an environment that ' +
            'can\'t instantiate its wasm). Reinstall dependencies, or set `parser: "svelte"` ' +
            'to use svelte/compiler (the fallback parser).',
        );
    }
    parseByEngine.set(useRust, resolved);
    return resolved;
  };

  /** The module specifier the rewritten owner imports a given variant from. */
  const variantSpecifier = (variantId: string): string => {
    // `variantId` is `<childPath>::v<n>`; turn it into a query request on the
    // real child path so relative imports inside the residual still resolve.
    const sep = variantId.lastIndexOf('::v');
    const childPath = variantId.slice(0, sep);
    const n = variantId.slice(sep + 3);
    return `${childPath}?${VARIANT_QUERY}=${n}`;
  };

  return {
    name: 'vite-plugin-svelte-shaker',
    enforce: 'pre',
    // Build always; dev (serve) only when opted in via `dev` (docs §6.2).
    apply(_config, env) {
      return devMode != null || env.command === 'build';
    },

    configResolved(config) {
      root = config.root;
      log = (msg) => config.logger.info(`[svelte-shaker] ${msg}`);
      warn = (msg) => config.logger.warn(`[svelte-shaker] ${msg}`);
      // Prune the resolved `build.outDir` (the destination this build overwrites —
      // normally it can hold no source the app depends on) plus any user-declared
      // `exclude` (an adapter's `build/`, a `dist/`).  docs §8.1.1.
      //
      // But a misconfigured `outDir` that is the crawl root itself or an ANCESTOR
      // of an entry dir (e.g. `outDir: '.'`) would prune real source — a silent
      // over-shake.  Sound-first: in that case skip the automatic `outDir`
      // exclusion and warn, keeping only what the user explicitly listed.
      const outDir = path.resolve(root, config.build.outDir);
      const entryDirs = (options.entries ?? ['.']).map((p) => path.resolve(root, p));
      const outDirCoversSource = entryDirs.some(
        (d) => d === outDir || d.startsWith(outDir + path.sep),
      );
      if (outDirCoversSource) {
        warn(
          `build.outDir (${path.relative(root, outDir) || '.'}) is the crawl root or ` +
            `contains an entry directory, so excluding it would prune source; skipping the ` +
            `automatic build-output exclusion. Set an outDir outside your source, or list the ` +
            `real output dir in the \`exclude\` option.`,
        );
      }
      const autoExclude = outDirCoversSource ? [] : [outDir];
      exclude = compileExclude(root, [...autoExclude, ...(options.exclude ?? [])]);
    },

    // Dev (serve): drive the long-lived incremental engine instead of the
    // one-shot build crawl.  `configureServer` runs before `buildStart`, so
    // setting `devShaker` here makes `buildStart` skip the build path (docs §3 M2).
    async configureServer(server) {
      if (!devMode) return;
      const dirs = (options.entries ?? ['.']).map((p) => path.resolve(root, p));
      // One dev-only predicate for the whole dev session, compiled against the Vite
      // root so custom patterns are root-relative regardless of which entry dir a
      // file sits under.  Fed to both scans and the watch guards below (docs §8.1.1).
      const isDevOnly = compileDevOnly(root, options.devOnly);
      // The engine's entry components, collected from the entry DIRS: `entries`
      // names the roots to crawl from, these are the `.svelte` files under them.
      const entryComponents = dirs.flatMap((d) => collectSvelteFiles(d, isDevOnly, exclude));
      const read = (id: ComponentId) => fs.readFileSync(id, 'utf-8');
      const underDirs = (file: string): boolean =>
        dirs.some((d) => file === d || file.startsWith(d + path.sep));

      // Re-scan the non-`.svelte` modules for `.svelte` call sites and re-apply
      // `preserve` (docs §4.2).  Dev uses the same relative-only `fsResolve` the dev
      // crawl uses, so the escape scope matches the crawl scope — dev is never more
      // unsound than build.  The sorted-join key lets a change that does not move the
      // escape set skip the reload.
      let escapedKey = '';
      const currentEscaped = async (): Promise<ComponentId[]> => {
        const result = await computeEscapedComponents({
          entryDirs: dirs,
          root,
          preserve: options.preserve,
          components: entryComponents,
          devOnly: isDevOnly,
          exclude,
          resolve: fsResolve,
          readFile: read,
        });
        reportEscapeDiagnostics(result);
        escapedKey = [...result.escaped].sort().join('\n');
        return result.escaped;
      };

      devShaker = new DevShaker(
        entryComponents,
        fsResolve,
        read,
        devMode,
        getParse(false),
        await currentEscaped(),
      );
      shaken = await devShaker.init();

      const applyDelta = (result: {
        changed: Record<ComponentId, string>;
        removed: ComponentId[];
      }): void => {
        for (const [id, code] of Object.entries(result.changed)) shaken[id] = code;
        for (const id of result.removed) delete shaken[id];
        server.moduleGraph.invalidateAll();
        server.ws.send({ type: 'full-reload' });
      };

      // A `.svelte` add/remove changes the call-site set (a new caller can
      // un-shake a child; a removed one can re-shake it — docs §4).  Re-shake and
      // full-reload: over-invalidation is always sound, and add/remove is rare
      // enough that fine-grained HMR for it is not worth the complexity here.
      // Dev-only files are discounted by both scans, so an edit to one never moves
      // the shake — skip them here too, or a `Foo.test.svelte` save would retrigger a
      // full re-shake for no effect.
      const isOurs = (file: string): boolean =>
        file.endsWith('.svelte') && underDirs(file) && !isDevOnly(file);
      const onGraphChange = async (file: string, kind: 'added' | 'removed'): Promise<void> => {
        if (!devShaker || !isOurs(file)) return;
        applyDelta(await devShaker.update({ [kind]: [file] }));
      };
      server.watcher.on('add', (file) => void onGraphChange(file, 'added'));
      server.watcher.on('unlink', (file) => void onGraphChange(file, 'removed'));

      // A non-`.svelte` module changing can add or drop a `.ts`/`.js` call site,
      // shifting the escape set — a component may now need bailing, or become
      // foldable again (docs §4.2).  Recompute; only when the set actually moved do
      // we re-shake and full-reload (over-invalidation is sound, but pointless
      // reloads on unrelated `.ts` edits are avoided).
      const onModuleChange = async (file: string): Promise<void> => {
        if (!devShaker || !isScannableModule(file) || !underDirs(file) || isDevOnly(file)) return;
        const before = escapedKey;
        devShaker.setEscaped(await currentEscaped());
        if (escapedKey === before) return;
        applyDelta(await devShaker.update({}));
      };
      server.watcher.on('change', (file) => void onModuleChange(file));
      server.watcher.on('add', (file) => void onModuleChange(file));
      server.watcher.on('unlink', (file) => void onModuleChange(file));
    },

    // Dev HMR: re-shake the changed file and WIDEN the update set with every
    // component whose slimmed output changed — crucially the un-edited children
    // whose residual shifted because a call site changed (the module-graph
    // divergence, docs §3 M2).  Returning a superset is sound; under-reporting
    // would leave stale output in the browser.
    async handleHotUpdate(ctx) {
      if (!devShaker || !ctx.file.endsWith('.svelte')) return;
      const result = await devShaker.update({ changed: [ctx.file] });
      for (const [id, code] of Object.entries(result.changed)) shaken[id] = code;
      for (const id of result.removed) delete shaken[id];

      const widened = new Set(ctx.modules);
      for (const id of Object.keys(result.changed)) {
        const mods = ctx.server.moduleGraph.getModulesByFile(id);
        if (!mods) continue;
        for (const m of mods) {
          // Invalidate so vite-plugin-svelte re-runs our `transform` (now serving
          // the new `shaken[id]`) and recompiles — including the extracted CSS in
          // the `?svelte&type=style` sub-resource (value-set narrowing's CSS rule
          // removal lives there).
          ctx.server.moduleGraph.invalidateModule(m);
          widened.add(m);
        }
      }
      return [...widened];
    },

    // Phase 1 (docs §6.1): crawl the whole component graph and compute plans
    // before any file is compiled.  Skipped in serve — `configureServer` owns the
    // dev path and has already populated `shaken` via the incremental engine.
    async buildStart() {
      if (devShaker) return;
      const dirs = (options.entries ?? ['.']).map((p) => path.resolve(root, p));
      // One dev-only predicate for both scans, compiled against the Vite root so
      // custom patterns are root-relative regardless of the entry dir (docs §8.1.1).
      const isDevOnly = compileDevOnly(root, options.devOnly);
      // The engine's entry components, collected from the entry DIRS: `entries`
      // names the roots to crawl from, these are the `.svelte` files under them.
      const entryComponents = dirs.flatMap((d) => collectSvelteFiles(d, isDevOnly, exclude));
      if (entryComponents.length === 0) {
        shaken = {};
        variantSources = new Map();
        return;
      }
      const read = (id: ComponentId) => fs.readFileSync(id, 'utf-8');

      // Resolve relative imports straight off disk (fast, and the id matches what
      // Vite hands `transform`), but send bare specifiers through Vite's resolver
      // so a component library consumed as `@scope/ui` (the design-system shape) is
      // crawled into the program and shaken instead of treated as an opaque
      // external.  The arrow keeps `this` bound to the Rollup plugin context.
      const resolve: Resolve = async (source, importer) => {
        if (source.startsWith('.') || path.isAbsolute(source)) return fsResolve(source, importer);
        // `this.resolve` THROWS for specifiers some plugin in the chain rejects
        // (a types-only subpath like `svelte/elements`, a virtual id, etc.).  A
        // specifier we cannot resolve is simply out of scope — never a build
        // error — so swallow it and leave that barrel branch unfollowed.
        let resolved: Awaited<ReturnType<typeof this.resolve>>;
        try {
          resolved = await this.resolve(source, importer);
        } catch {
          return null;
        }
        if (!resolved || resolved.external) return null;
        return resolved.id.split('?')[0]!;
      };

      // Components used from OUTSIDE the `.svelte` graph must not be folded (docs
      // §4.2): those a non-`.svelte` module imports (found by the scan) plus any the
      // user pinned via `preserve`.  Hand the engine that escape set, and surface the
      // scan's diagnostics (unparseable modules / unmatched `preserve`) as warnings.
      const escapeScan = await computeEscapedComponents({
        entryDirs: dirs,
        root,
        preserve: options.preserve,
        components: entryComponents,
        devOnly: isDevOnly,
        exclude,
        resolve,
        readFile: read,
      });
      reportEscapeDiagnostics(escapeScan);
      const escaped = escapeScan.escaped;

      // The monomorphization net-win gate's size proxy, computed by rsvelte's client
      // codegen (`@rsvelte/compiler`), for the JS and WASM engines so their gate decides
      // byte-for-byte like the native engine (which computes the SAME proxy in-process).
      // Loaded lazily by the js/wasm mono branches only — the native path sizes in Rust
      // and never needs it. If `@rsvelte/compiler` can't load, sizing returns null and
      // the gate specializes nothing — sound (never bloat), just unoptimized.
      const loadOwnSize = (): OwnSize => tryLoadRsvelteOwnSize() ?? (() => null);

      // Decide the engine. The native (napi) Rust engine parses with rsvelte IN
      // PROCESS and keeps the ASTs Rust-side, so no whole-program AST crosses a
      // boundary — it is the fastest and has no size ceiling. The WASM engine is the
      // SAME Rust engine but marshals the whole-program AST across the JS<->WASM
      // boundary as JSON (tens of MB past a few hundred components), so `auto` only
      // uses it below the size gate; past it the boundary-free JS engine wins.
      //   `'rust'` — native if it loads, else WASM (throws if neither can load).
      //   `'auto'` — native if it loads; else WASM below the gate; else JS.
      //   `'js'`   — the JS engine.
      // All three are differentially tested to emit byte-identical output.
      const engineChoice = options.engine ?? 'auto';
      // `parser: 'svelte'` asks for svelte/compiler, which the native engine (always
      // in-process rsvelte) cannot honor — so it forces the native engine off, and the
      // shake falls back to a WASM/JS engine that parses with the requested parser.
      const nativeAllowed = options.parser !== 'svelte';
      let native: ReturnType<typeof tryLoadNativeEngine> = null;
      let wasm: ReturnType<typeof tryLoadWasmEngine> = null;
      if (engineChoice === 'rust') {
        native = nativeAllowed ? tryLoadNativeEngine() : null;
        if (!native) {
          wasm = tryLoadWasmEngine();
          if (!wasm)
            throw new Error(
              '[vite-plugin-svelte-shaker] engine: "rust" was requested but neither the native ' +
                'nor the WASM Rust engine could be loaded. Remove the option (or use engine: "js") ' +
                'to use the JS engine.',
            );
        }
      } else if (engineChoice === 'auto') {
        native = nativeAllowed ? tryLoadNativeEngine() : null;
        if (!native && entryComponents.length <= RUST_ENGINE_MAX_COMPONENTS) {
          wasm = tryLoadWasmEngine();
        }
      }

      if (native) {
        // Native Rust engine (napi): parses with rsvelte in process, shakes over the
        // retained ASTs, and returns only the edits — byte-identical to the JS engine,
        // monomorphization included (mono off -> an empty variant set). The `parser`
        // option does not apply here (the session always parses in-process rsvelte).
        //
        // Defense in depth: `tryLoadNativeEngine` already rejects an ABI-incompatible
        // binary (`engineApiVersion`), but any OTHER native failure (a napi marshaling
        // error, an unforeseen throw) must NOT crash the build — degrade to the JS
        // engine with a warning. `session.shake` is `catch_unwind`, so a native panic
        // surfaces here as a throw rather than aborting the process.
        try {
          const result = await svelteShakerNativeWithMono(
            native,
            entryComponents,
            resolve,
            read,
            mono,
            escaped,
          );
          shaken = result.files;
          variantSources = result.variants;
          reportSizes(shaken, read, root, options.verbose === true, log);
          return;
        } catch (err) {
          warn(
            `the native engine failed at runtime (${err instanceof Error ? err.message : String(err)}); ` +
              `falling back to the JS engine for this build`,
          );
          native = null;
          wasm = null; // fall through to the always-available JS engine below
        }
      }

      if (wasm) {
        // WASM Rust engine — byte-identical to the JS engine, including
        // monomorphization.
        if (mono.enabled) {
          const result = await svelteShakerWasmWithMono(
            wasm,
            entryComponents,
            resolve,
            read,
            mono,
            loadOwnSize(),
            getParse(true),
            escaped,
          );
          shaken = result.files;
          variantSources = result.variants;
        } else {
          shaken = await svelteShakerWasm(
            wasm,
            entryComponents,
            resolve,
            read,
            getParse(true),
            escaped,
          );
          variantSources = new Map();
        }
        reportSizes(shaken, read, root, options.verbose === true, log);
        return;
      }

      if (!mono.enabled) {
        // JS engine, monomorphization off: byte-for-byte the unused-prop fold /
        // constant fold / value-set narrowing output.
        shaken = await svelteShaker(entryComponents, resolve, read, getParse(false), escaped);
        variantSources = new Map();
        reportSizes(shaken, read, root, options.verbose === true, log);
        return;
      }

      const result = await svelteShakerWithMono(
        entryComponents,
        resolve,
        read,
        mono,
        variantSpecifier,
        getParse(false),
        escaped,
        loadOwnSize(),
      );
      shaken = result.files;
      variantSources = new Map();
      for (const v of result.mono.variants.values())
        variantSources.set(variantSpecifier(v.id), v.code);
      reportSizes(shaken, read, root, options.verbose === true, log);
    },

    // A `?shaker_variant` request resolves to the real child path (so relative
    // imports inside it work); we keep the query so `load`/`transform` can tell
    // the variant apart from the base module.  Returning the id verbatim marks it
    // resolved by us.
    resolveId(source, importer) {
      if (!source.includes(`${VARIANT_QUERY}=`)) return null;
      const [spec, query] = source.split('?');
      if (!spec || !spec.endsWith('.svelte')) return null;
      // Resolve the child path relative to the importer (the rewritten owner).
      const base = importer ? path.dirname(importer.split('?')[0]!) : root;
      const abs = spec.startsWith('.') ? path.resolve(base, spec) : spec;
      return `${abs}?${query}`;
    },

    load(id) {
      // Vite's default loader reads the file on disk ignoring the query, which
      // would give the UNspecialized child source.  Serve the variant residual
      // ourselves so the `?shaker_variant` request gets the specialized code.
      if (!id.includes(`${VARIANT_QUERY}=`)) return null;
      return variantSources.get(id) ?? null;
    },

    // Phase 2: hand the slimmed source to the Svelte plugin.
    transform(code, id) {
      // A specialized-variant request: its source is already the residual we put
      // there in `load`, so let it flow through to vite-plugin-svelte untouched.
      if (id.includes(`${VARIANT_QUERY}=`)) return null;
      // Only the *main* `.svelte` module request must be slimmed. vite-plugin-svelte
      // splits a component into sub-resource requests (`Foo.svelte?svelte&type=style&lang.css`,
      // `…&type=script`) whose path still ends in `.svelte`; returning the full
      // slimmed source for those would clobber the extracted CSS/JS with raw
      // component source. Skip anything carrying the Svelte sub-resource marker.
      if (id.includes('svelte&type=')) return null;
      const file = id.split('?')[0]!;
      if (!file.endsWith('.svelte')) return null;
      const out = shaken[file];
      if (out == null || out === code) return null;
      // Real shaken→original mappings are a later engine milestone
      // (docs/RUST-MIGRATION.md — `TransformResult.map`). Until then we replace
      // the source without a map, so we return the `{ mappings: '' }` sentinel that
      // Rollup's public `SourceMapInput` type carries as an explicit member: its
      // runtime (`decodedSourcemap`) special-cases that value as "no map declared"
      // and skips it instead of setting the missing-map flag, so SOURCEMAP_BROKEN
      // never fires. A bare string would leave the flag set and trigger the warning.
      return { code: out, map: { mappings: '' } };
    },
  };
}
