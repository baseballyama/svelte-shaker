// ----------------------------------------------------------------------
// L2 per-call-site monomorphization (docs/ARCHITECTURE.md §3 "L2", §11, §13.2).
//
// OPT-IN, BAIL-SAFE, and — the property this module guarantees — NEVER BLOATING.
// Where L1 folds a prop only when it is the SAME constant across the whole app,
// and L1.5 narrows a multi-valued prop without folding it, L2 specializes a call
// site: `<Btn variant="primary"/>` could get a private copy of `Btn` in which
// `variant` is the constant `'primary'`, so every non-primary branch and CSS rule
// folds away — even though `variant` is app-wide multi-valued and therefore NOT
// foldable by L1/L1.5.
//
// THE KEY INSIGHT (docs §3 L2, §11) — why we do NOT specialize everything:
//   L1.5 already removes every arm that is dead APP-WIDE.  So splitting a
//   component into per-shape copies only ever SHRINKS the bundle when the
//   specialization makes a whole MODULE become globally unreferenced — which
//   happens for CORRELATED multi-prop conditions that L1.5's independent
//   per-prop narrowing cannot kill.  Canonical example:
//     Child: {#if a === 1 && b === 1}<Heavy/>{/if}<p>base</p>
//     app-wide a∈{0,1}, b∈{0,1}, sites are only <Child a={0} b={1}/> and
//     <Child a={1} b={0}/> — never (1,1).
//   L1.5 keeps <Heavy/> (it narrows a and b independently and cannot prove
//   `a && b` is never both 1), so Heavy stays in the bundle.  L2 specializes each
//   site (a or b becomes a constant) -> in BOTH variants `{#if a===1&&b===1}`
//   folds false -> <Heavy/> is gone from every variant -> Heavy is globally
//   unreferenced -> the bundler drops Heavy entirely.  THAT is the win.
//   Conversely a plain `variant∈{a,b}` with inline arms and no module elimination
//   MUST NOT be specialized: per-shape copies just duplicate scaffolding and GROW
//   the bundle.
//
// SOUNDNESS (the whole contract — docs §13.2):
//   * We only specialize a LIVE call site (never one inside a dead `{#if}` span
//     — same predicate the fixpoint uses).
//   * We only fold a prop at a site when its value is a literal no spread can
//     override (`afterLastSpread && !dynamic`) — the partial-bail rule (docs §4.1).
//   * We never specialize a BAILED component (escape / barrel / accessors), a
//     prop shadowed by a binding, a `{@debug}` prop, or a prop already folded by
//     L1.  The residual is produced by the SAME audited body pipeline as
//     L0/L1/L1.5 ({@link shakeBody}); L2 only chooses a richer fold environment.
//
// NEVER-BLOAT, MEASURED NET-WIN GATE (docs §3 L2, §13.2 — replaces the old
// "specialize any folding site" behaviour):
//   1. ALL-SITES-OR-NOTHING per child C: we only consider specializing C if
//      EVERY live call site of C across the whole program maps to a NON-base
//      residual (a real variant).  If any live site would keep C's base, we do
//      NOT specialize C — otherwise the base module stays referenced AND variants
//      are added, which is pure bloat.  All-sites means C's base becomes globally
//      unreferenced, so the bundler can drop it.
//   2. We build the whole-program LIVE RENDER graph (component -> components it
//      renders) and measure, with a per-module byte proxy ({@link ownSize}:
//      compiled client JS length), the total module bytes reachable from the
//      shake entries in two scenarios: BASE (C unspecialized) and SPEC (C's sites
//      render the variants, C.base removed, each variant renders its own live
//      children).  We specialize C IFF Sigma_spec < Sigma_base * (1 - minSavings)
//      — a strict, measured net reduction.  When in doubt we keep the base.
// ----------------------------------------------------------------------

import MagicString from 'magic-string';
import { compile } from 'svelte/compiler';
import { inSpans } from './dead.js';
import { shakeBody } from './transform.js';
import {
  readCallSite,
  deadSpansForPlans,
  isFoldBlockedName,
  type FileModel,
  type PropDecl,
} from './analyze.js';
import { parseSvelte, walk, type AnyNode } from './parse.js';
import type { ComponentId, ComponentPlan, Literal } from './ir.js';

/** Tuning knobs for L2 (docs §8.1, §13.2).  All have sound defaults. */
export interface MonomorphizeOptions {
  /** Master switch.  Default OFF — every existing behavior is unchanged. */
  enabled: boolean;
  /**
   * Cap on distinct specialized variants generated per component (docs §13.2
   * "maxVariants").  Dedup by residual means this counts *distinct residuals*,
   * not call sites; if a child's distinct residuals exceed the cap it cannot be
   * specialized all-sites, so it keeps the base entirely.  Default 8.
   */
  maxVariants: number;
  /**
   * Minimum FRACTION of the base-scenario module bytes the specialization must
   * save before we apply it (docs §13.2 "measured net-win").  `0` (default) means
   * specialize on ANY strict net reduction (`Sigma_spec < Sigma_base`); `0.15`
   * would require a >=15% reduction.  Higher is more conservative; it can never
   * make L2 bloat, only decline more.
   */
  minSavings: number;
}

export const DEFAULT_MONO_OPTIONS: MonomorphizeOptions = {
  enabled: false,
  maxVariants: 8,
  minSavings: 0,
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

/** A single live `<Child .../>` site that could be specialized. */
interface Candidate {
  owner: ComponentId;
  node: AnyNode;
  shape: Map<string, Literal>;
  /** The residual source this site folds to (the dedup key). */
  code: string;
}

/**
 * Compute per-call-site specialized residuals and the dedup'd variant set under
 * a MEASURED, never-bloat net-win gate (docs §3 L2, §13.2).
 *
 * Pure over `models`/`plans`: it reads the already-computed plans, finds the
 * live call sites whose extra literal props fold, groups them per child, and —
 * for each child — only specializes when (a) EVERY live site of that child gets
 * a non-base residual (all-sites-or-nothing, so the base module becomes
 * unreferenced) and (b) replacing the child with its variants strictly shrinks
 * the whole-program module bytes reachable from `entries`.  It never mutates the
 * inputs and never touches the base transform, so with L2 off (or when no child
 * passes the gate) the default whole-program output is byte-for-byte unchanged.
 */
export function monomorphize(
  models: Map<ComponentId, FileModel>,
  plans: Map<ComponentId, ComponentPlan>,
  options: MonomorphizeOptions = DEFAULT_MONO_OPTIONS,
  entries: ComponentId | ComponentId[] = [],
): MonomorphizeResult {
  const variants = new Map<string, Variant>();
  const bindings: CallSiteBinding[] = [];
  if (!options.enabled) return { variants, bindings };

  // Exclude call sites inside a dead `{#if}` span — the SAME predicate the
  // fixpoint and transform use, so we never specialize a site that vanishes.
  const deadSpans = deadSpansForPlans(models, plans);

  // (1) Gather, per child, EVERY live `<Child .../>` site and whether it folds
  // anything extra.  A child is only a specialization candidate if every one of
  // its live sites folds a non-base residual (all-sites-or-nothing).
  const liveSitesByChild = new Map<ComponentId, Candidate[]>();
  const ineligible = new Set<ComponentId>(); // a live site that cannot specialize

  for (const owner of models.values()) {
    const dead = deadSpans.get(owner.id) ?? [];
    for (const call of owner.childCalls) {
      if (dead.length > 0 && inSpans(call.node, dead)) continue; // dead site
      const child = models.get(call.childId);
      const childPlan = plans.get(call.childId);
      if (!child || !childPlan) continue;
      // Never specialize a fully-bailed child (escape/barrel/accessors): its
      // prop profile is unobservable, so a "specialized" copy could be wrong.
      if (childPlan.bail || !child.props || child.props.length === 0) {
        ineligible.add(call.childId);
        continue;
      }

      const shape = specializableShape(call.node, child, childPlan);
      if (shape.size === 0) {
        // This live site keeps the base — so we can never make the base module
        // unreferenced.  Disqualify the whole child (all-sites-or-nothing).
        ineligible.add(call.childId);
        continue;
      }
      const code = renderResidual(child, childPlan, shape);
      if (code === baseResidual(child, childPlan)) {
        // The extra literals fold nothing the base did not -> base residual ->
        // this site keeps the base.  Disqualify the child.
        ineligible.add(call.childId);
        continue;
      }
      const list = liveSitesByChild.get(call.childId);
      if (list) list.push({ owner: owner.id, node: call.node, shape, code });
      else liveSitesByChild.set(call.childId, [{ owner: owner.id, node: call.node, shape, code }]);
    }
  }

  // (2) Build the whole-program base render graph + the base module sizes, and
  // the set of components reachable from the shake entries.  `ownSize` is
  // memoized (compile is the hot cost) and a compile error makes a component
  // non-specializable (we treat it as un-sizable -> skip any child involved).
  const baseSource = baseSourceMap(models, plans);
  const baseChildrenOf = new Map<ComponentId, ComponentId[]>();
  for (const model of models.values())
    baseChildrenOf.set(model.id, liveChildIds(baseSource.get(model.id)!, model));

  // Reachability roots = the shake entries (docs §3 L2, §13.2), narrowed to the
  // TRUE import-graph roots.  The Shell seeds the crawl with EVERY `.svelte` file
  // (so it can attribute every call site), which would make every module its own
  // root and defeat reachability — so we drop any entry that is itself rendered
  // by another component.  What remains are the real app entry points, and a
  // module reachable only through a folded-away edge becomes orphan-able.
  const incoming = new Set<ComponentId>();
  for (const children of baseChildrenOf.values()) for (const c of children) incoming.add(c);
  const entryList = (Array.isArray(entries) ? entries : [entries]).filter((e) => models.has(e));
  const roots = entryList.filter((e) => !incoming.has(e));

  const sizeCache = new Map<string, number>();
  const ownSize = (id: ComponentId, source: string): number | null => {
    const cached = sizeCache.get(source);
    if (cached !== undefined) return cached;
    let size: number | null;
    try {
      const { js } = compile(source, {
        generate: 'client',
        dev: false,
        filename: id,
      });
      size = js.code.length;
    } catch {
      size = null; // un-sizable -> caller skips the child
    }
    if (size !== null) sizeCache.set(source, size);
    return size;
  };

  // The children that are still in the running after the all-sites filter.  A
  // child whose live-site OWNER is itself such a candidate must NOT be
  // specialized: when the owner is specialized, its live `<Child .../>` site
  // moves into the owner's variant residual (un-rewritten -> renders the BASE
  // child), so the base child stays referenced.  Specializing it anyway would
  // emit its variants AND keep its base = bloat.  Declining nested
  // specialization is the conservative, never-bloat choice (candidate
  // interactions are a documented followup, docs §3 L2 / §13.2); the owner's own
  // net-win already accounts for rendering the base child.
  const candidateChildren = new Set<ComponentId>();
  for (const childId of liveSitesByChild.keys())
    if (!ineligible.has(childId)) candidateChildren.add(childId);

  // (3) Decide each candidate child independently against the base scenario
  // (docs §13.2: candidate interactions are a followup; independence is sound
  // because every decision is measured against the SAME base and only applied on
  // a strict net reduction, so the union can never bloat past base).
  for (const [childId, sites] of liveSitesByChild) {
    if (ineligible.has(childId)) continue; // some live site keeps the base
    // A live-site owner is itself specializable -> declining avoids base+variant
    // bloat of THIS child (see `candidateChildren`).
    if (sites.some((s) => s.owner !== childId && candidateChildren.has(s.owner))) continue;

    // Dedup the candidate sites' residuals into the distinct variant set.
    const residualToVariant = new Map<string, string>();
    const variantSources: Array<{ id: string; code: string }> = [];
    let overCap = false;
    for (const site of sites) {
      if (residualToVariant.has(site.code)) continue;
      if (variantSources.length >= options.maxVariants) {
        overCap = true; // can't give every distinct shape a variant -> bail child
        break;
      }
      const vid = `${childId}::v${variantSources.length}`;
      residualToVariant.set(site.code, vid);
      variantSources.push({ id: vid, code: site.code });
    }
    if (overCap) continue; // exceeding the cap means we cannot specialize all-sites

    // Measure: does replacing the base child with its variants strictly shrink
    // the whole-program reachable module bytes?
    if (
      !netWin(
        childId,
        variantSources,
        models,
        baseSource,
        baseChildrenOf,
        roots,
        ownSize,
        options.minSavings,
      )
    )
      continue;

    // The gate passed: emit the variants and bind every live site.
    for (const v of variantSources) {
      const site = sites.find((s) => s.code === v.code)!;
      variants.set(v.id, {
        id: v.id,
        childId,
        code: v.code,
        foldedProps: site.shape,
      });
    }
    for (const site of sites) {
      bindings.push({
        owner: site.owner,
        childId,
        node: site.node,
        variantId: residualToVariant.get(site.code)!,
        foldedProps: site.shape,
      });
    }
  }

  return { variants, bindings };
}

/**
 * The measured net-win gate (docs §3 L2, §13.2).  Returns true iff replacing the
 * base child `childId` with its `variantSources` strictly shrinks the total
 * module bytes reachable from `roots`:
 *
 *   Sigma_base = sum over the BASE-reachable component set of ownSize(base).
 *   Sigma_spec = same reachability but with the child expanded into its
 *                variants: the child's incoming edges go to the variants, the
 *                child's base module is gone, and each variant renders its OWN
 *                live children.  ownSize(variant) for variants, base size for
 *                everything else.
 *
 * Specialize IFF Sigma_spec < Sigma_base * (1 - minSavings).  Any compile error
 * (un-sizable module) makes us decline — never bloat.
 */
function netWin(
  childId: ComponentId,
  variantSources: Array<{ id: string; code: string }>,
  models: Map<ComponentId, FileModel>,
  baseSource: Map<ComponentId, string>,
  baseChildrenOf: Map<ComponentId, ComponentId[]>,
  roots: ComponentId[],
  ownSize: (id: ComponentId, source: string) => number | null,
  minSavings: number,
): boolean {
  // The variants' OWN live children, parsed from each variant residual via the
  // child's import map (variants never add imports — they only fold/remove).
  const childModel = models.get(childId)!;
  const variantChildren = new Map<string, ComponentId[]>();
  for (const v of variantSources) variantChildren.set(v.id, liveChildIds(v.code, childModel));

  // --- Sigma_base: reachable set in the BASE scenario, sized by base residual.
  const baseReached = new Set<ComponentId>();
  const stackB = [...roots];
  while (stackB.length > 0) {
    const id = stackB.pop()!;
    if (baseReached.has(id)) continue;
    baseReached.add(id);
    for (const c of baseChildrenOf.get(id) ?? []) stackB.push(c);
  }
  let sigmaBase = 0;
  for (const id of baseReached) {
    const size = ownSize(id, baseSource.get(id)!);
    if (size === null) return false; // un-sizable -> decline
    sigmaBase += size;
  }

  // --- Sigma_spec: reachability with the child expanded into its variants.
  //   * reached non-variant components are sized by their base residual,
  //   * each reached variant by its own residual,
  //   * the child's base module is NOT a node (its edges redirect to variants).
  // A worklist over a tagged node: either a real component id or a variant id.
  const allVariantIds = variantSources.map((v) => v.id);
  const reachedComponents = new Set<ComponentId>();
  const reachedVariants = new Set<string>();
  // Redirect any edge into the child to ALL its variants (all-sites means every
  // live caller now renders a variant; for a sound upper bound we keep them all).
  const expand = (id: ComponentId): { comps: ComponentId[]; vars: string[] } =>
    id === childId ? { comps: [], vars: allVariantIds } : { comps: [id], vars: [] };

  const compStack: ComponentId[] = [];
  const varStack: string[] = [];
  for (const r of roots) {
    const e = expand(r);
    compStack.push(...e.comps);
    varStack.push(...e.vars);
  }
  while (compStack.length > 0 || varStack.length > 0) {
    if (compStack.length > 0) {
      const id = compStack.pop()!;
      if (reachedComponents.has(id)) continue;
      reachedComponents.add(id);
      for (const c of baseChildrenOf.get(id) ?? []) {
        const e = expand(c);
        compStack.push(...e.comps);
        varStack.push(...e.vars);
      }
      continue;
    }
    const vid = varStack.pop()!;
    if (reachedVariants.has(vid)) continue;
    reachedVariants.add(vid);
    for (const c of variantChildren.get(vid) ?? []) {
      const e = expand(c);
      compStack.push(...e.comps);
      varStack.push(...e.vars);
    }
  }

  let sigmaSpec = 0;
  for (const id of reachedComponents) {
    const size = ownSize(id, baseSource.get(id)!);
    if (size === null) return false;
    sigmaSpec += size;
  }
  for (const vid of reachedVariants) {
    const src = variantSources.find((v) => v.id === vid)!.code;
    const size = ownSize(vid, src);
    if (size === null) return false;
    sigmaSpec += size;
  }

  return sigmaSpec < sigmaBase * (1 - minSavings);
}

/**
 * The live child component ids a `.svelte` SOURCE renders: parse it and resolve
 * every `<Child .../>` tag through `model.imports` (local name -> child id).
 * Folding removes dead `<Child/>` tags from the source, so parsing the RESIDUAL
 * (not the original) yields exactly the edges that survive — which is what makes
 * a correlated condition able to orphan a whole module.  A parse error yields no
 * edges (sound: it only ever shrinks the reachable set, never grows it; and a
 * residual that fails to parse would also fail to compile in {@link ownSize},
 * declining the child).
 */
function liveChildIds(source: string, model: FileModel): ComponentId[] {
  let ast;
  try {
    ast = parseSvelte(source, model.id);
  } catch {
    return [];
  }
  const ids: ComponentId[] = [];
  walk<null>(ast.fragment, null, {
    Component(node, { next }) {
      const childId = node.name ? model.imports.get(node.name) : undefined;
      if (childId) ids.push(childId);
      next();
    },
  });
  return ids;
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
    const decl = declared.get(name);
    if (!decl) continue; // undeclared -> flows to `...rest`, skip
    if (plan.constFold.has(name)) continue; // already an app-wide L1 constant
    // A nested-pattern entry (`null` local) is unfoldable, and a prop whose LOCAL
    // binding is shadowed / used in `{@debug}` must not fold — both exactly as L1.
    if (decl.local === null || isFoldBlockedName(child, decl.local)) continue;
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
  for (const [name, set] of plan.narrow) if (!env.has(name)) setEnv.set(name, set);

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

/**
 * The base residual SOURCE per component — the same body shake the whole-program
 * transform emits ({@link baseResidual}), keyed by component id.  This is the
 * per-module source the net-win gate sizes and the source whose `<Child/>` tags
 * define the base render graph.  (It omits the owner's call-site attribute
 * stripping, which never changes the child's own rendered children or the
 * component's compiled size in a way that affects the comparison — both
 * scenarios share it.)
 */
function baseSourceMap(
  models: Map<ComponentId, FileModel>,
  plans: Map<ComponentId, ComponentPlan>,
): Map<ComponentId, string> {
  const out = new Map<ComponentId, string>();
  for (const model of models.values()) {
    const plan = plans.get(model.id)!;
    out.set(model.id, plan.bail ? model.code : baseResidual(model, plan));
  }
  return out;
}
