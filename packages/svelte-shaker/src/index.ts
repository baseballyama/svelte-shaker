import * as fs from 'node:fs';
import * as path from 'node:path';
import { analyze, type ReadFile, type Resolve } from './analyze';
import { transformAll, transformAllWithMono } from './transform';
import {
  monomorphize,
  DEFAULT_MONO_OPTIONS,
  type MonomorphizeOptions,
  type MonomorphizeResult,
} from './mono';
import type { ComponentId } from './ir';

export type { ComponentId } from './ir';
export type { Resolve, ReadFile } from './analyze';
export { analyze } from './analyze';
export { transformAll, transformAllWithMono } from './transform';
export { collectSvelteFiles } from './scan';
export {
  monomorphize,
  DEFAULT_MONO_OPTIONS,
  type MonomorphizeOptions,
  type MonomorphizeResult,
  type Variant,
  type CallSiteBinding,
} from './mono';

/**
 * Whole-program shake: crawl the component graph from `entry`, decide what to
 * fold, and return the shaken source for every reachable `.svelte` file.
 *
 * `resolve` / `readFile` are injected so the engine stays environment-free
 * (a Vite plugin passes `this.resolve`; tests pass node:fs). See
 * docs/ARCHITECTURE.md §5 — this is the Engine; the Shell owns resolution.
 */
export async function svelteShaker(
  entries: ComponentId | ComponentId[],
  resolve: Resolve,
  readFile: ReadFile = (id) => fs.readFileSync(id, 'utf-8'),
): Promise<Record<ComponentId, string>> {
  const { models, plans } = await analyze(entries, resolve, readFile);
  return transformAll(models, plans);
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
  readFile: ReadFile = (id) => fs.readFileSync(id, 'utf-8'),
  mono: MonomorphizeOptions = DEFAULT_MONO_OPTIONS,
  variantSpecifier: VariantSpecifier = (id) => id,
): Promise<ShakeResult> {
  const { models, plans } = await analyze(entries, resolve, readFile);
  const result = monomorphize(models, plans, mono);
  // With no bindings the wired pass and the base pass are identical, so reuse
  // the plain transform to keep the default path byte-for-byte unchanged.
  const files =
    result.bindings.length === 0
      ? transformAll(models, plans)
      : transformAllWithMono(
          models,
          plans,
          result.bindings.map((b) => ({
            owner: b.owner,
            node: b.node,
            variantId: b.variantId,
            foldedProps: b.foldedProps,
          })),
          variantSpecifier,
        );
  return { files, mono: result };
}

/** Default filesystem resolver: resolve `source` relative to its importer. */
export const fsResolve: Resolve = (source, importer) => {
  if (!source.startsWith('.')) return null; // bare imports aren't local components
  return path.resolve(path.dirname(importer), source);
};
