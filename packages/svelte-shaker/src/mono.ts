// ----------------------------------------------------------------------
// L2 per-call-site monomorphization (docs/ARCHITECTURE.md §3 "L2", §13.2).
//
// OPT-IN and BAIL-SAFE.  Where L1 folds a prop only when it is the SAME constant
// across the whole app, and L1.5 narrows a multi-valued prop without folding it,
// L2 specializes a SINGLE call site: `<Btn variant="primary"/>` gets a private
// copy of `Btn` in which `variant` is the constant `'primary'`, so every
// non-primary branch and CSS rule folds away — even though `variant` is
// app-wide multi-valued and therefore NOT foldable by L1/L1.5.
//
// SOUNDNESS (the whole contract — docs §13.2):
//   * We only specialize a LIVE call site (never one inside a dead `{#if}`
//     span — same predicate the fixpoint uses).
//   * We only fold a prop at a site when that prop's value is a literal that no
//     spread can override (`afterLastSpread && !dynamic`) — exactly the
//     partial-bail rule the analysis applies.  Folding it is then a sound
//     substitution: the residual is observably identical to the base component
//     for the value that actually occurs at that site (proven by differential
//     SSR in the tests).
//   * We never specialize a BAILED component (escape / barrel / accessors), a
//     prop shadowed by a template/instance binding, a `{@debug}` prop, or a prop
//     already folded by L1 (no benefit).  When nothing extra can fold, the site
//     keeps the base component.
//   * The residual is produced by the SAME audited body pipeline as L0/L1/L1.5
//     ({@link shakeBody}); L2 only chooses a richer fold environment.
//
// DEDUP BY RESIDUAL (docs §13.2): two call sites whose specialized residual
// SOURCE is byte-identical share ONE generated module (the shape KEY is the
// residual itself, so semantically identical copies never both exist).  A small
// `maxVariants` cap per component guards code-size regression; over it, the
// extra sites fall back to the base component (always sound).
//
// This module is the ENGINE half (docs §11 M6 approach b): it computes the
// specialized residuals + dedup map and exposes them.  The Vite plugin wires
// them to real modules via virtual `resolveId`/`load` (see `vite.ts`); when that
// wiring cannot be done soundly it simply does not specialize (the base output
// is always correct), so default behavior is never broken.
// ----------------------------------------------------------------------

import MagicString from 'magic-string';
import { inSpans } from './dead';
import { shakeBody } from './transform';
import {
  readCallSite,
  deadSpansForPlans,
  type FileModel,
  type PropDecl,
} from './analyze';
import type { AnyNode } from './parse';
import type { ComponentId, ComponentPlan, Literal } from './ir';

/** Tuning knobs for L2 (docs §8.1, §13.2).  All have sound defaults. */
export interface MonomorphizeOptions {
  /** Master switch.  Default OFF — every existing behavior is unchanged. */
  enabled: boolean;
  /**
   * Cap on distinct specialized variants generated per component (docs §13.2
   * "maxVariants").  Dedup by residual means this counts *distinct residuals*,
   * not call sites; over the cap, surplus sites keep the base component.
   * Default 8.
   */
  maxVariants: number;
}

export const DEFAULT_MONO_OPTIONS: MonomorphizeOptions = {
  enabled: false,
  maxVariants: 8,
};

/**
 * One generated specialized module for a component shape.
 *
 * `key` is the dedup key — the residual SOURCE itself, so two shapes with
 * identical residuals collapse to one variant (docs §13.2).  `code` is the
 * slimmed `.svelte` source; `foldedProps` records which props this variant
 * folded to which literal (the call-site shape), so the Shell can strip those
 * attributes from the rewritten call site.
 */
export interface Variant {
  /** Stable id `<childId>::v<n>` — used as the virtual module specifier. */
  id: string;
  /** The component this is a specialization of. */
  childId: ComponentId;
  /** Slimmed `.svelte` source (the residual). */
  code: string;
  /** Props this variant froze to a literal (name -> value). */
  foldedProps: Map<string, Literal>;
}

/** One call site that was assigned to a specialized variant. */
export interface CallSiteBinding {
  /** The component that renders this `<Child .../>`. */
  owner: ComponentId;
  /** The component being called. */
  childId: ComponentId;
  /** The `<Child .../>` AST node (so the Shell can rewrite this exact site). */
  node: AnyNode;
  /** The variant this site resolves to. */
  variantId: string;
  /**
   * The props THIS site froze to a literal.  May differ from the resolved
   * variant's `foldedProps` when two shapes dedup to one residual (a frozen prop
   * that the residual ignores); the rewrite must strip THIS site's frozen attrs,
   * so the binding carries its own shape rather than the dedup target's.
   */
  foldedProps: Map<string, Literal>;
}

/** The complete L2 result the Shell consumes. */
export interface MonomorphizeResult {
  /** Every generated variant, keyed by its id. */
  variants: Map<string, Variant>;
  /** Per (owner, node) the variant a call site was specialized to. */
  bindings: CallSiteBinding[];
}

/**
 * Compute per-call-site specialized residuals and the dedup'd variant set.
 *
 * Pure over `models`/`plans`: it reads the already-computed plans, finds the
 * live call sites whose extra literal props can fold, runs {@link shakeBody}
 * with the augmented environment, dedups by residual source, and returns the
 * variants + the call-site→variant bindings.  It never mutates the inputs and
 * never touches the base transform, so with L2 off (or no eligible site) the
 * default whole-program output is byte-for-byte unchanged.
 */
export function monomorphize(
  models: Map<ComponentId, FileModel>,
  plans: Map<ComponentId, ComponentPlan>,
  options: MonomorphizeOptions = DEFAULT_MONO_OPTIONS,
): MonomorphizeResult {
  const variants = new Map<string, Variant>();
  const bindings: CallSiteBinding[] = [];
  if (!options.enabled) return { variants, bindings };

  // Exclude call sites inside a dead `{#if}` span — the SAME predicate the
  // fixpoint and transform use, so we never specialize a site that vanishes.
  const deadSpans = deadSpansForPlans(models, plans);

  // Per child, dedup variants by residual source -> assigned variant id, and
  // count distinct variants for the `maxVariants` cap.
  const residualToVariant = new Map<ComponentId, Map<string, string>>();
  const variantCount = new Map<ComponentId, number>();

  for (const owner of models.values()) {
    const dead = deadSpans.get(owner.id) ?? [];
    for (const call of owner.childCalls) {
      if (dead.length > 0 && inSpans(call.node, dead)) continue; // dead site
      const child = models.get(call.childId);
      const childPlan = plans.get(call.childId);
      if (!child || !childPlan) continue;
      // Never specialize a fully-bailed child (escape/barrel/accessors): its
      // prop profile is unobservable, so a "specialized" copy could be wrong.
      if (childPlan.bail || !child.props || child.props.length === 0) continue;

      const shape = specializableShape(call.node, child, childPlan);
      if (shape.size === 0) continue; // nothing extra folds -> keep base

      // Build the residual via the audited body pipeline with the augmented
      // fold environment (base L1 constants + this site's extra literals).
      const code = renderResidual(child, childPlan, shape);

      // Dedup by residual SOURCE (docs §13.2): identical residuals share one
      // variant.  A no-op residual (identical to the base output) means the
      // extra literals folded nothing the base did not — skip (no benefit).
      if (code === baseResidual(child, childPlan)) continue;

      let byResidual = residualToVariant.get(child.id);
      if (!byResidual) {
        byResidual = new Map();
        residualToVariant.set(child.id, byResidual);
      }
      let variantId = byResidual.get(code);
      if (variantId === undefined) {
        const n = variantCount.get(child.id) ?? 0;
        if (n >= options.maxVariants) continue; // cap reached -> keep base
        variantId = `${child.id}::v${n}`;
        byResidual.set(code, variantId);
        variantCount.set(child.id, n + 1);
        variants.set(variantId, {
          id: variantId,
          childId: child.id,
          code,
          foldedProps: shape,
        });
      }
      bindings.push({
        owner: owner.id,
        childId: child.id,
        node: call.node,
        variantId,
        foldedProps: shape,
      });
    }
  }

  return { variants, bindings };
}

/**
 * The set of EXTRA props this call site freezes to a literal — props that:
 *   - are declared by the child (`...rest` only holds undeclared props, so a
 *     declared prop is always safe to fold — same as L0/L1),
 *   - are passed a literal at this site that no spread can override
 *     (`afterLastSpread && !dynamic`) — the partial-bail rule (docs §4.1),
 *   - are NOT already folded by L1 (`constFold`) — those carry no extra info,
 *   - are NOT shadowed by a template/instance binding or used in `{@debug}` —
 *     the analysis already refuses to fold those, and so must we.
 *
 * Returns name -> literal value.  Empty means this site cannot be specialized
 * beyond what the base component already does.
 */
function specializableShape(
  node: AnyNode,
  child: FileModel,
  plan: ComponentPlan,
): Map<string, Literal> {
  const site = readCallSite(node);
  const declared = new Map<string, PropDecl>();
  for (const d of child.props ?? []) declared.set(d.name, d);

  const shape = new Map<string, Literal>();
  for (const [name, explicit] of site.explicit) {
    if (!declared.has(name)) continue; // undeclared -> flows to `...rest`, skip
    if (plan.constFold.has(name)) continue; // already an app-wide L1 constant
    if (child.shadowedNames.has(name) || child.debugNames.has(name)) continue;
    // The value must be a literal this site genuinely passes and no spread can
    // override — exactly the analysis's "safely explicit" condition.
    if (explicit.dynamic || !explicit.afterLastSpread) continue;
    shape.set(name, explicit.value);
  }
  return shape;
}

/**
 * Render a component's residual for an augmented fold environment.  Reuses the
 * exact L0/L1/L1.5 pipeline: `env` = the child's app-wide L1 constants PLUS this
 * site's extra literals; `setEnv` = the child's narrow sets MINUS any prop now
 * frozen by `env` (a frozen prop is a constant, no longer a set).
 */
function renderResidual(
  child: FileModel,
  plan: ComponentPlan,
  extra: Map<string, Literal>,
): string {
  const env = new Map<string, Literal>(plan.constFold);
  for (const [name, value] of extra) env.set(name, value);
  const setEnv = new Map<string, Literal[]>();
  for (const [name, set] of plan.narrow)
    if (!env.has(name)) setEnv.set(name, set);

  const s = new MagicString(child.code);
  shakeBody(child, env, setEnv, plan, s);
  return s.toString();
}

/**
 * The child's BASE residual (what the whole-program transform already emits for
 * it under L1/L1.5 alone).  Used to detect a no-op specialization: if the extra
 * literals fold nothing the base did not, the residual equals this and the site
 * keeps the base component (no pointless variant).  Memoized per child.
 */
const baseCache = new WeakMap<FileModel, string>();
function baseResidual(child: FileModel, plan: ComponentPlan): string {
  const cached = baseCache.get(child);
  if (cached !== undefined) return cached;
  const s = new MagicString(child.code);
  shakeBody(child, plan.constFold, plan.narrow, plan, s);
  const code = s.toString();
  baseCache.set(child, code);
  return code;
}
