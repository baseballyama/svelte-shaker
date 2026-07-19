import * as fs from 'node:fs';
import * as path from 'node:path';
import { compile } from 'svelte/compiler';
import type { Plugin } from 'vite';
import { svelteShaker, svelteShakerWithMono, type Parse, type Resolve } from './index.js';
import { DevShaker, type DevMode } from './engine.js';
import { collectSvelteFiles, fsResolve } from './scan.js';
import { DEFAULT_MONO_OPTIONS, type MonomorphizeOptions } from './mono.js';
import { tryLoadRsvelteParser } from './rsvelte-parse.js';
import { svelteShakerWasm, svelteShakerWasmWithMono, tryLoadWasmEngine } from './wasm-engine.js';
import type { ComponentId } from './ir.js';

export interface ShakerOptions {
  /**
   * Directories (relative to the Vite root) to scan for `.svelte` components.
   * Defaults to the Vite root itself.  Every `.svelte` file found is treated as
   * a call-site source, so the union of these dirs must contain the whole app
   * for prop elimination to be sound (docs/ARCHITECTURE.md §4.2).
   */
  include?: string[];
  /**
   * Optimization level (docs §3).  L0/L1/L1.5 are always on; `level: 2`
   * additionally enables L2 per-call-site monomorphization.  **Default `2`** — L2
   * is ON by default because it is bail-safe and never bloats (the measured
   * net-win gate, docs §3 L2).  Set `level: 1` (or `0`) to turn L2 OFF, e.g. to
   * trade a little compression for faster builds.
   */
  level?: 0 | 1 | 2;
  /**
   * L2 monomorphization tuning (docs §13.2).  Consulted whenever L2 is active
   * (i.e. not turned off via `level: 1`/`0`).  `true`/omitted enables it with
   * defaults; an object overrides `maxVariants` / `minSavings`; `false` turns L2
   * OFF (same as `level: 1`).  Raising `maxVariants` lets children with more
   * distinct call-site shapes be specialized — affordable now that the net-win
   * gate only sizes the modules that actually differ (docs §13.2).
   */
  monomorphize?: boolean | Partial<Omit<MonomorphizeOptions, 'enabled'>>;
  /**
   * Which engine runs the whole shake (analysis + transform, INCLUDING L2).
   * Default `'auto'`.  The native Rust (WASM) engine implements every level — for
   * L2 it calls back into JS only for the per-module compiled-size proxy the
   * net-win gate needs — so it is the default fast path:
   *  - `'auto'` — use the native Rust engine when it can be loaded; otherwise fall
   *    back to the JS engine.
   *  - `'rust'` — force the Rust engine; throws if the WASM module can't be loaded.
   *  - `'js'` — force the JS engine.
   * Both engines are differentially tested to produce byte-identical output, so the
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
   * L2 is NOT applied in dev (L0/L1/L1.5 only — docs §5 risks).
   */
  dev?: false | DevMode;
  /**
   * Which parser feeds the engine (docs/RUST-MIGRATION.md §6).  Default
   * `'svelte'` — svelte/compiler, byte-for-byte the established behavior.
   * `'rsvelte'` uses rsvelte's native parser (the OPTIONAL peer
   * `@rsvelte/vite-plugin-svelte-native`), which parses ~2.2x faster (full
   * pipeline ~1.46x) and shakes a sound superset.  The engine reads only UTF-16
   * `start`/`end`, so the choice never affects soundness — only speed and
   * (occasionally) how much is shaken.  If `'rsvelte'` is requested but the native
   * package can't be loaded (not installed, or no binary for this platform) the
   * plugin THROWS rather than silently falling back, so the output stays
   * deterministic across machines (install the peer on every build platform).
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
 * Resolve the {@link MonomorphizeOptions} from the public option surface.  L2 is
 * ON by default (it is bail-safe and never bloats); it is disabled only by an
 * explicit opt-out — `level: 1`/`0` or `monomorphize: false`.  An object
 * `monomorphize` overrides the tuning knobs (`maxVariants` / `minSavings`).
 */
function resolveMono(options: ShakerOptions): MonomorphizeOptions {
  const optedOut = options.level === 0 || options.level === 1 || options.monomorphize === false;
  if (optedOut) return DEFAULT_MONO_OPTIONS;
  const overrides = typeof options.monomorphize === 'object' ? options.monomorphize : {};
  return { ...DEFAULT_MONO_OPTIONS, enabled: true, ...overrides };
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
 * L2 wiring (opt-in, `level: 2`): a specialized variant is exposed as a request
 * for the ORIGINAL child file with a `?shaker_variant=<id>` query.  Keeping the
 * real `.svelte` path means the variant's own relative imports (`./Icon.svelte`)
 * resolve exactly as they would in the unspecialized child, and vite-plugin-svelte
 * still compiles it as a normal component; our `transform` swaps in the variant
 * residual for that id.  Two call sites with byte-identical residuals share one
 * variant id (dedup), so they share one compiled module.
 */
export function shaker(options: ShakerOptions = {}): Plugin {
  const mono = resolveMono(options);
  let shaken: Record<ComponentId, string> = {};
  /** Variant request id (`<childPath>?shaker_variant=<n>`) -> residual source. */
  let variantSources = new Map<string, string>();
  let root = process.cwd();
  // Vite's logger, captured in `configResolved`; until then fall back to console
  // so the size report still surfaces if `buildStart` somehow runs first.
  let log: (msg: string) => void = (msg) => console.info(`[svelte-shaker] ${msg}`);

  // Dev (serve) shaking is opt-in (docs §6.2); `null` keeps dev a pass-through.
  const devMode: DevMode | null =
    options.dev === 'coarse' || options.dev === 'incremental' ? options.dev : null;
  /** The long-lived incremental engine, created in `configureServer` (serve only). */
  let devShaker: DevShaker | null = null;

  // Resolve the parser ONCE (lazily, so the optional native package is only loaded
  // when `parser: 'rsvelte'` is actually used). `undefined` means svelte/compiler.
  // An explicit `parser: 'rsvelte'` that can't load THROWS rather than silently
  // falling back to svelte/compiler: a silent fallback would make the same source
  // shake differently depending on whether the optional native binary happens to be
  // installed on this platform — a reproducibility footgun. Failing loudly keeps the
  // chosen parser (and thus the output) deterministic.
  let parseResolved = false;
  let parse: Parse | undefined;
  const getParse = (): Parse | undefined => {
    if (parseResolved) return parse;
    parseResolved = true;
    if (options.parser === 'rsvelte') {
      parse = tryLoadRsvelteParser() ?? undefined;
      if (!parse)
        throw new Error(
          '[vite-plugin-svelte-shaker] parser: "rsvelte" was requested but the optional ' +
            'peer `@rsvelte/vite-plugin-svelte-native` could not be loaded (not installed, or ' +
            'no prebuilt binary for this platform). Install it on every build platform, or ' +
            'remove `parser: "rsvelte"` to use svelte/compiler.',
        );
    }
    return parse;
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
    },

    // Dev (serve): drive the long-lived incremental engine instead of the
    // one-shot build crawl.  `configureServer` runs before `buildStart`, so
    // setting `devShaker` here makes `buildStart` skip the build path (docs §3 M2).
    async configureServer(server) {
      if (!devMode) return;
      const dirs = (options.include ?? ['.']).map((p) => path.resolve(root, p));
      const entries = dirs.flatMap(collectSvelteFiles);
      const read = (id: ComponentId) => fs.readFileSync(id, 'utf-8');
      devShaker = new DevShaker(entries, fsResolve, read, devMode, getParse());
      shaken = await devShaker.init();

      // A `.svelte` add/remove changes the call-site set (a new caller can
      // un-shake a child; a removed one can re-shake it — docs §4).  Re-shake and
      // full-reload: over-invalidation is always sound, and add/remove is rare
      // enough that fine-grained HMR for it is not worth the complexity here.
      const isOurs = (file: string): boolean =>
        file.endsWith('.svelte') && dirs.some((d) => file === d || file.startsWith(d + path.sep));
      const onGraphChange = async (file: string, kind: 'added' | 'removed'): Promise<void> => {
        if (!devShaker || !isOurs(file)) return;
        const result = await devShaker.update({ [kind]: [file] });
        for (const [id, code] of Object.entries(result.changed)) shaken[id] = code;
        for (const id of result.removed) delete shaken[id];
        server.moduleGraph.invalidateAll();
        server.ws.send({ type: 'full-reload' });
      };
      server.watcher.on('add', (file) => void onGraphChange(file, 'added'));
      server.watcher.on('unlink', (file) => void onGraphChange(file, 'removed'));
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
          // the `?svelte&type=style` sub-resource (L1.5 rule removal lives there).
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
      const dirs = (options.include ?? ['.']).map((p) => path.resolve(root, p));
      const entries = dirs.flatMap(collectSvelteFiles);
      if (entries.length === 0) {
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

      // Decide the engine.  The native Rust engine now implements every level
      // INCLUDING L2 (it calls back to JS only for the compiled-size proxy), so it
      // is the default: `'auto'` uses it whenever it can be loaded and falls back
      // to JS otherwise, `'rust'` forces it (throwing if it can't load), `'js'`
      // forces the JS engine.  Both engines produce byte-identical output.
      const engineChoice = options.engine ?? 'auto';
      let wasm: ReturnType<typeof tryLoadWasmEngine> = null;
      if (engineChoice === 'rust') {
        wasm = tryLoadWasmEngine();
        if (!wasm)
          throw new Error(
            '[vite-plugin-svelte-shaker] engine: "rust" was requested but the WASM engine ' +
              'could not be loaded. Remove the option (or use engine: "js") to use the JS engine.',
          );
      } else if (engineChoice === 'auto') {
        wasm = tryLoadWasmEngine();
      }

      if (wasm) {
        // Native Rust engine — byte-identical to the JS engine, including L2.
        if (mono.enabled) {
          const result = await svelteShakerWasmWithMono(
            wasm,
            entries,
            resolve,
            read,
            mono,
            getParse(),
          );
          shaken = result.files;
          variantSources = result.variants;
        } else {
          shaken = await svelteShakerWasm(wasm, entries, resolve, read, getParse());
          variantSources = new Map();
        }
        reportSizes(shaken, read, root, options.verbose === true, log);
        return;
      }

      if (!mono.enabled) {
        // JS engine, L2 off: byte-for-byte the L0/L1/L1.5 output.
        shaken = await svelteShaker(entries, resolve, read, getParse());
        variantSources = new Map();
        reportSizes(shaken, read, root, options.verbose === true, log);
        return;
      }

      const result = await svelteShakerWithMono(
        entries,
        resolve,
        read,
        mono,
        variantSpecifier,
        getParse(),
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
