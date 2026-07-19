import {
  analyze,
  analyzeInput,
  buildAnalyzeInput,
  type ReadFile,
  type Resolve,
} from './analyze.js';
import { type Parse, type ParseCache } from './parse.js';
import { transformAll, transformAllWithMono } from './transform.js';
import {
  monomorphize,
  DEFAULT_MONO_OPTIONS,
  type MonomorphizeOptions,
  type MonomorphizeResult,
} from './mono.js';
import { shakeWithRevertCascade } from './revert-cascade.js';
import type { ComponentId } from './ir.js';

export type {
  ComponentId,
  AnalyzeInput,
  InputFile,
  ResolvedEdge,
  EdgeKind,
  EditResult,
} from './ir.js';
export type { Resolve, ReadFile, ResolveSync, ReadFileSync } from './analyze.js';
export type { Parse, Root } from './parse.js';
export {
  analyze,
  analyzeInput,
  buildAnalyzeInput,
  buildAnalyzeInputSync,
  deadSpansForPlans,
  findNeverPassedProps,
} from './analyze.js';
export type { UnpassedProp } from './analyze.js';
export { DevShaker, type DevMode, type DevShakerChange } from './engine.js';
export { transformAll, transformAllWithMono } from './transform.js';
export {
  monomorphize,
  DEFAULT_MONO_OPTIONS,
  type MonomorphizeOptions,
  type MonomorphizeResult,
  type Variant,
  type CallSiteBinding,
} from './mono.js';

/**
 * Whole-program shake: crawl the component graph from `entry`, decide what to
 * fold, and return the shaken source for every reachable `.svelte` file.
 *
 * `resolve` / `readFile` are injected so the engine stays environment-free —
 * it has NO `node:*` imports, so it runs unchanged in the browser (the
 * playground passes an in-memory file map). A Vite plugin passes `this.resolve`;
 * Node callers use `fsResolve` / `fs.readFileSync` from `svelte-shaker/node`.
 * See docs/ARCHITECTURE.md §5 — this is the Engine; the Shell owns resolution.
 */
export async function svelteShaker(
  entries: ComponentId | ComponentId[],
  resolve: Resolve,
  readFile: ReadFile,
  parse?: Parse,
): Promise<Record<ComponentId, string>> {
  const { models, plans } = await analyzeWith(entries, resolve, readFile, parse);
  return shakeWithRevertCascade(models, plans, (p) => transformAll(models, p));
}

/**
 * Crawl + analyze with an optional non-default parser ({@link Parse}).  When
 * `parse` is given (the Vite plugin's `parser: 'rsvelte'` path), each file is
 * parsed ONCE into a shared cache during the crawl and that cache is reused by the
 * analysis — so the alternate parser drives the whole engine with no second parse.
 * When omitted, this is exactly `analyze(entries, resolve, readFile)` (the default
 * svelte/compiler path, byte-for-byte unchanged).
 */
async function analyzeWith(
  entries: ComponentId | ComponentId[],
  resolve: Resolve,
  readFile: ReadFile,
  parse: Parse | undefined,
): ReturnType<typeof analyze> {
  if (!parse) return analyze(entries, resolve, readFile);
  const cache: ParseCache = new Map();
  const input = await buildAnalyzeInput(entries, resolve, readFile, cache, parse);
  return analyzeInput(input, cache);
}

/** The full output of a shake including L2 specialization. */
export interface ShakeResult {
  /**
   * Whole-program output: shaken source per `.svelte` file.  With L2 OFF this is
   * byte-for-byte identical to {@link svelteShaker}; with L2 ON, owner files
   * whose call sites were specialized have those sites rewritten to import a
   * variant via `variantSpecifier(variantId)`.
   */
  files: Record<ComponentId, string>;
  /** L2 specialized variants + call-site bindings (empty when L2 is off). */
  mono: MonomorphizeResult;
}

/** Build the module specifier a rewritten call site imports a variant from. */
export type VariantSpecifier = (variantId: string) => string;

/**
 * Whole-program shake WITH optional L2 monomorphization (docs §3 "L2").
 *
 * `mono` carries the specialized variants (id -> residual source) and the call
 * sites bound to them; `files` is the wired owner source.  The Shell resolves
 * `variantSpecifier(id)` to a virtual module whose source is
 * `mono.variants.get(id)!.code`.  With `mono.enabled` false (default) nothing is
 * specialized and `files` equals the L0/L1/L1.5 output exactly — a strict
 * superset of the default behavior, so existing consumers are unaffected.
 */
export async function svelteShakerWithMono(
  entries: ComponentId | ComponentId[],
  resolve: Resolve,
  readFile: ReadFile,
  mono: MonomorphizeOptions = DEFAULT_MONO_OPTIONS,
  variantSpecifier: VariantSpecifier = (id) => id,
  parse?: Parse,
): Promise<ShakeResult> {
  const { models, plans } = await analyzeWith(entries, resolve, readFile, parse);
  // The cascade may re-run the transform with force-bailed plans, so recompute L2
  // inside it: a bailed component must not be specialized either.  `lastResult`
  // captures the mono result of the final (converged or no-op) pass.  On the no-op
  // fallback the emitted owner files are the untouched originals — they import no
  // variant — so any variants `lastResult` still lists are simply never requested.
  let lastResult!: MonomorphizeResult;
  const files = shakeWithRevertCascade(models, plans, (p) => {
    // Thread the shake entries through so the net-win gate can compute module
    // reachability from them (docs §3 L2, §13.2).
    lastResult = monomorphize(models, p, mono, entries);
    // With no bindings the wired pass and the base pass are identical, so reuse
    // the plain transform to keep the default path byte-for-byte unchanged.
    return lastResult.bindings.length === 0
      ? transformAll(models, p)
      : transformAllWithMono(
          models,
          p,
          lastResult.bindings.map((b) => ({
            owner: b.owner,
            node: b.node,
            variantId: b.variantId,
            foldedProps: b.foldedProps,
          })),
          variantSpecifier,
        );
  });
  return { files, mono: lastResult };
}
