/**
 * Whole-program fixpoint core (docs ARCHITECTURE §2.1): build a model per file, then
 * alternate collecting live call-site usage and recomputing plans until they stop
 * changing. The environment-free engine entry ({@link analyzeInput}) and the
 * lint-oriented {@link findNeverPassedProps} live here; resolution/IO is
 * {@link buildAnalyzeInput} (crawl.ts), per-file facts are model.ts, call-site
 * reading is call-site.ts.
 */
import { type ParseCache } from './parse.js';
import {
  emptyPlan,
  isFoldableValue,
  type AnalyzeInput,
  type ComponentId,
  type ComponentPlan,
  type Literal,
  type ResolvedEdge,
} from './ir.js';
import { computeDeadSpans, inSpans, type Span } from './dead.js';
import { buildModelFromInput, type FileModel } from './model.js';
import {
  readCallSite,
  valueSetFor,
  type CallSite,
  type OwnerEnv,
  type OwnerFoldEnv,
} from './call-site.js';
import { buildAnalyzeInput, type ReadFile, type Resolve } from './crawl.js';

export interface AnalyzeResult {
  models: Map<ComponentId, FileModel>;
  plans: Map<ComponentId, ComponentPlan>;
}

/** Floor for the fixpoint iteration bound (see {@link fixpointIterationBound}). */
const MIN_FIXPOINT_ITERATIONS = 10;

/**
 * How many refinement rounds the fixpoint may run before giving up.
 *
 * Pass-through propagation (docs §13.1) advances exactly one hop per round: a
 * folded owner prop is only visible to the round that reads the PREVIOUS round's
 * folds, so a value forwarded down an N-component chain needs N rounds to reach
 * the leaf.  A forwarding chain can be at most as long as the component count, so
 * `components + 1` rounds let every reachable fold converge (the `+ 1` is the
 * extra round that observes the last fold and lets `plansEqual` stop).  A
 * {@link MIN_FIXPOINT_ITERATIONS} floor keeps tiny programs unaffected.
 *
 * This is not a performance knob: convergence is monotone (dead spans only grow
 * as profiles shrink), so `plansEqual` stops shallow programs in 2–3 rounds and
 * the bound is never approached.  It exists purely to guarantee termination if a
 * future non-monotone bug ever makes the plans oscillate — the bound stays finite
 * so we stop on the last stable plans rather than loop forever.  Should that
 * insurance ever trigger, the wasted work scales with this bound, i.e. grows with
 * the project's component count rather than staying a fixed constant. */
function fixpointIterationBound(componentCount: number): number {
  return Math.max(MIN_FIXPOINT_ITERATIONS, componentCount + 1);
}

/** Bail reason stamped on a component leaked as a value (docs §4.1 escape). */
const ESCAPE_REASON = 'escapes as value (e.g. <svelte:component this={X}>)';

/** Bail reason stamped on a component with a consumer OUTSIDE the analyzed
 * `.svelte` graph — a call site in a non-`.svelte` module the crawl cannot
 * parse, or a user-declared `preserve` (docs §4.2, {@link AnalyzeInput.escaped}).
 * Kept byte-identical to the Rust engine's constant so the two agree. */
const MODULE_ESCAPE_REASON = 'has a consumer outside the analyzed .svelte graph';

/**
 * Stamp {@link MODULE_ESCAPE_REASON} on every model in `escaped` that exists in
 * the program — the single injection point both the whole-program shake and
 * {@link findNeverPassedProps} share (docs §4.2).  Ids not in the program are
 * ignored (a stale `preserve` entry or a scanned import to a component outside
 * the crawl is simply a no-op, never an error).
 */
function stampModuleEscapes(
  models: Map<ComponentId, FileModel>,
  escaped: ComponentId[] | undefined,
): void {
  for (const id of escaped ?? []) {
    const model = models.get(id);
    if (model && !model.bailReasons.includes(MODULE_ESCAPE_REASON))
      model.bailReasons.push(MODULE_ESCAPE_REASON);
  }
}

/**
 * Union every component leaked as a value across the program (docs §4.1 escape) —
 * e.g. `<svelte:component this={X}>` — and stamp {@link ESCAPE_REASON} on each, so
 * `buildPlan` bails it and the fixpoint never folds it.  The single injection point
 * both the whole-program shake ({@link analyzeInput}) and {@link findNeverPassedProps}
 * share, so an escaped component's unobservable prop profile is bailed identically.
 */
function stampEscapes(models: Map<ComponentId, FileModel>): void {
  const escaped = new Set<ComponentId>();
  for (const model of models.values()) for (const id of model.escapedComponents) escaped.add(id);
  for (const id of escaped) {
    const model = models.get(id);
    if (model && !model.bailReasons.includes(ESCAPE_REASON)) model.bailReasons.push(ESCAPE_REASON);
  }
}

/**
 * Crawl the component graph from `entries` and compute a plan per component,
 * iterating to a whole-program fixpoint (docs §2.1).
 *
 * The crucial cascade: a `<Child/>` that lives inside a branch we fold away must
 * NOT count toward the child's prop profile.  Excluding it can shrink the
 * child's value sets and enable more folding, which can fold away yet more
 * branches.  So we parse every component once, then alternate between
 *   (a) collecting call sites that are NOT inside a current dead span, and
 *   (b) recomputing plans (and hence dead spans) from that usage,
 * until the plans stop changing.
 */
export async function analyze(
  entries: ComponentId | ComponentId[],
  resolve: Resolve,
  readFile: ReadFile,
  escaped: ComponentId[] = [],
): Promise<AnalyzeResult> {
  return analyzeInput(
    await buildAnalyzeInput(entries, resolve, readFile, undefined, undefined, escaped),
  );
}

/**
 * The pure, environment-free engine entry (docs/RUST-MIGRATION.md §2): given a
 * fully-resolved, batched {@link AnalyzeInput}, build every component's model and
 * compute its plan to a whole-program fixpoint (docs §2.1).  It does NO module
 * resolution or file IO — that is the Shell-side resolution layer's job
 * ({@link buildAnalyzeInput}) — so this is the half that ports to Rust unchanged:
 * one batched call in, plans out, no per-edge callback across the boundary.
 */
export function analyzeInput(input: AnalyzeInput, parseCache?: ParseCache): AnalyzeResult {
  const models = buildModels(input, parseCache);

  // Escape bail (docs §4.1): any component leaked as a value somewhere in the
  // program (e.g. `<svelte:component this={X}>`) has an unobservable prop
  // profile, so it must be left completely untouched.  Stamp every escaped
  // component BEFORE planning, so `buildPlan` bails it and the fixpoint never
  // folds it.
  stampEscapes(models);
  // Components with consumers outside the `.svelte` graph (a call site in a
  // non-`.svelte` module or a user `preserve`, docs §4.2) join the same
  // whole-component escape bail.
  stampModuleEscapes(models, input.escaped);

  return { models, plans: planFixpoint(models) };
}

/**
 * Compute every component's plan to a whole-program fixpoint (docs §2.1) from the
 * models' current `bailReasons` (escape stamps, and — on a revert re-run — the
 * cascade's force-bail stamps).  Extracted so the revert cascade can RECOMPUTE the
 * whole fixpoint after force-bailing a component, not just patch that one plan:
 * with interprocedural pass-through (docs §13.1) a child's fold can depend on an
 * owner's fold, so force-bailing the owner must un-fold the child too — an
 * in-place patch of only the owner's plan would leave the child's drop stale
 * (unsound).  This mirrors the Rust engine, which re-runs `run_fixpoint` after
 * stamping `forceBail` onto the models.
 */
export function planFixpoint(models: Map<ComponentId, FileModel>): Map<ComponentId, ComponentPlan> {
  // Round 0: every call site counts (no dead spans yet) — the plain, non-cascade
  // analysis.  The owner fold env is empty here, so a forwarded expression only
  // folds when it is a pure literal expression (`v={'a' + 'b'}`); owner-prop
  // references stay dynamic until a later round has folded them.  Each subsequent
  // round recomputes dead spans from the previous plans and re-derives plans from
  // the surviving call sites, evaluating forwarded expressions against the
  // PREVIOUS round's owner folds, until the plans stop changing.
  const noPlans = new Map<ComponentId, ComponentPlan>();
  let plans = buildPlans(models, buildUsage(models, new Map()), noPlans);

  const bound = fixpointIterationBound(models.size);
  for (let i = 0; i < bound; i++) {
    const deadSpans = deadSpansForPlans(models, plans);
    const nextPlans = buildPlans(models, buildUsage(models, deadSpans), plans);
    // Convergence is monotone: excluding a folded-away call site can only shrink
    // a child's value set (or clear `dynamic`/`top`), never grow it, so dead
    // spans only grow. Equal plans => a true fixpoint; we then stop.
    if (plansEqual(plans, nextPlans)) {
      plans = nextPlans;
      break;
    }
    plans = nextPlans;
  }

  return plans;
}

/**
 * Build a {@link FileModel} per `.svelte` file from the batched input — the
 * resolution-free counterpart of the old crawl.  Models are created in the
 * input's file order (the Shell crawls breadth-first), so the output order is
 * stable and matches the pre-batch behavior.
 */
function buildModels(input: AnalyzeInput, parseCache?: ParseCache): Map<ComponentId, FileModel> {
  // Group resolved edges by their owning file so each model reads only its own.
  const edgesByFrom = new Map<ComponentId, ResolvedEdge[]>();
  for (const edge of input.edges) {
    const list = edgesByFrom.get(edge.from);
    if (list) list.push(edge);
    else edgesByFrom.set(edge.from, [edge]);
  }
  const models = new Map<ComponentId, FileModel>();
  for (const file of input.files) {
    models.set(file.id, buildModelFromInput(file, edgesByFrom.get(file.id) ?? [], parseCache));
  }
  return models;
}

/** Mutable accumulator of how a child component is called across the program. */
interface Usage {
  sites: CallSite[];
}

/**
 * Aggregate every component's call sites into per-child {@link Usage}, EXCLUDING
 * any `<Child/>` whose node falls inside a dead `{#if}` span of its containing
 * component.  This is what makes the cascade sound: a folded-away call site does
 * not contribute to the child's prop profile.
 */
function buildUsage(
  models: Map<ComponentId, FileModel>,
  deadSpans: Map<ComponentId, Span[]>,
): Map<ComponentId, Usage> {
  const usage = new Map<ComponentId, Usage>();
  const usageOf = (id: ComponentId): Usage => {
    let u = usage.get(id);
    if (!u) {
      u = { sites: [] };
      usage.set(id, u);
    }
    return u;
  };

  for (const model of models.values()) {
    const dead = deadSpans.get(model.id) ?? [];
    for (const call of model.childCalls) {
      // Soundness: only EXCLUDE a site that is provably inside a dead span (by
      // the SAME predicate the transform uses). Live sites always count.
      if (dead.length > 0 && inSpans(call.node, dead)) continue;
      usageOf(call.childId).sites.push(readCallSite(call.node, model.id));
    }
  }
  return usage;
}

/** Shared empty owner env (a forwarded expression sees no constants). */
const EMPTY_ENV: ReadonlyMap<string, Literal> = new Map();
/** Shared empty owner set env (a forwarded bare id sees no narrowed sets). */
const EMPTY_SET_ENV: ReadonlyMap<string, Literal[]> = new Map();

/** Shared empty {@link OwnerFoldEnv} (no owner, or an owner that folds nothing). */
const EMPTY_OWNER_ENV: OwnerFoldEnv = { fold: EMPTY_ENV, narrow: EMPTY_SET_ENV };

/**
 * Merge an owner's static script constants ({@link FileModel.scriptConstEnv})
 * with its remapped folded props into a single fold env.  The two key spaces are
 * DISJOINT by construction: a folded prop is keyed by the LOCAL binding name its
 * `$props()` destructure introduces, and a script const by its top-level
 * declarator name; a top-level `const`/`let` reusing a `$props()` local name is a
 * JS redeclaration error, so no name can appear in both.  The merge is therefore
 * order-independent — folded props are applied last purely to document that
 * invariant — and either operand is returned as-is when the other is empty (the
 * common case: no owner-forwarded expressions, or a prop-less component).
 */
function mergeScriptConsts(
  scriptConsts: ReadonlyMap<string, Literal>,
  foldedProps: ReadonlyMap<string, Literal>,
): ReadonlyMap<string, Literal> {
  if (scriptConsts.size === 0) return foldedProps;
  if (foldedProps.size === 0) return scriptConsts;
  const merged = new Map(scriptConsts);
  for (const [name, value] of foldedProps) merged.set(name, value);
  return merged;
}

/**
 * Recompute every component's plan from the (cascade-filtered) usage, evaluating
 * forwarded call-site expressions against `prevPlans` — the PREVIOUS fixpoint
 * round's folds (docs §13.1 interprocedural pass-through).  Using the previous
 * round (never the plans being built) keeps the derivation order-independent and
 * sound: `prevPlans` describes the owner's runtime for real, so a forwarded
 * expression that evaluates to a literal is a value the child provably receives.
 * The remap-to-local of each owner's env is memoized per round, so it runs once
 * per owner however many children it forwards to (no O(n²)).
 */
function buildPlans(
  models: Map<ComponentId, FileModel>,
  usage: Map<ComponentId, Usage>,
  prevPlans: Map<ComponentId, ComponentPlan>,
): Map<ComponentId, ComponentPlan> {
  const envCache = new Map<ComponentId, OwnerFoldEnv>();
  const ownerEnv: OwnerEnv = (owner) => {
    if (owner === undefined) return EMPTY_OWNER_ENV;
    const cached = envCache.get(owner);
    if (cached) return cached;
    const model = models.get(owner);
    let env = EMPTY_OWNER_ENV;
    if (model) {
      const plan = prevPlans.get(owner);
      // A bailed owner still forwards its own SCRIPT CONSTANTS unchanged — its
      // bail only makes ITS props unobservable, but it keeps rendering its call
      // sites (docs §4.2 "自身のコールサイトは数える"), so `scriptConstEnv` (a
      // static source fact) participates regardless of `plan.bail`.  Only the
      // fold/narrow derived from the owner's OWN prop plan is gated on the plan
      // being present and not bailed.
      const foldable = plan !== undefined && !plan.bail;
      const foldedProps =
        foldable && plan.constFold.size > 0 ? remapToLocalNames(plan.constFold, model) : EMPTY_ENV;
      const narrow =
        foldable && plan.narrow.size > 0 ? remapToLocalNames(plan.narrow, model) : EMPTY_SET_ENV;
      const fold = mergeScriptConsts(model.scriptConstEnv, foldedProps);
      if (fold.size > 0 || narrow.size > 0) env = { fold, narrow };
    }
    envCache.set(owner, env);
    return env;
  };

  const plans = new Map<ComponentId, ComponentPlan>();
  for (const model of models.values()) {
    plans.set(model.id, buildPlan(model, usage.get(model.id), ownerEnv));
  }
  return plans;
}

/**
 * Fixpoint convergence test: the iteration is stable when every component's
 * foldable decisions (`constFold` + `narrow`) are unchanged.  Those two maps
 * fully determine the dead spans (via {@link computeDeadSpans}) and the editing,
 * so equal decisions => identical next round.  `bail` is structural (it never
 * changes across rounds) but is cheap to include for safety.
 */
function plansEqual(
  a: Map<ComponentId, ComponentPlan>,
  b: Map<ComponentId, ComponentPlan>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [id, pa] of a) {
    const pb = b.get(id);
    if (!pb) return false;
    if (pa.bail !== pb.bail) return false;
    if (!literalMapEqual(pa.constFold, pb.constFold)) return false;
    if (!literalArrayMapEqual(pa.narrow, pb.narrow)) return false;
  }
  return true;
}

function literalMapEqual(a: Map<string, Literal>, b: Map<string, Literal>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    if (!b.has(k) || !Object.is(b.get(k), v)) return false;
  }
  return true;
}

function literalArrayMapEqual(a: Map<string, Literal[]>, b: Map<string, Literal[]>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, va] of a) {
    const vb = b.get(k);
    // Value sets are order-stable (built by scanning sites in source order with
    // dedup), so a positional compare is sufficient and avoids set allocation.
    if (!vb || va.length !== vb.length) return false;
    for (let i = 0; i < va.length; i++) {
      if (!Object.is(va[i], vb[i])) return false;
    }
  }
  return true;
}

/**
 * Dead `{#if}` spans per component implied by `plans`, via the SAME shared
 * predicate the transform uses ({@link computeDeadSpans}).  A bailed component
 * folds nothing, so it has no dead spans.
 */
export function deadSpansForPlans(
  models: Map<ComponentId, FileModel>,
  plans: Map<ComponentId, ComponentPlan>,
): Map<ComponentId, Span[]> {
  const out = new Map<ComponentId, Span[]>();
  for (const model of models.values()) {
    const plan = plans.get(model.id)!;
    if (plan.bail) continue;
    // Dead spans are derived from the TEMPLATE, which references props by their
    // LOCAL binding name — so the fold/narrow maps (keyed by external prop name)
    // must be remapped here.  This MUST match the transform's own remap exactly,
    // or the fixpoint and the edit could disagree on what folds (unsound).
    const spans = computeDeadSpans(
      model.ast.fragment,
      remapToLocalNames(plan.constFold, model),
      remapToLocalNames(plan.narrow, model),
    );
    if (spans.length > 0) out.set(model.id, spans);
  }
  return out;
}

/** One declared prop that no call site in the program ever passes. `start`/`end`
 * are UTF-16 offsets of the prop's `$props()` destructuring property, for direct
 * source mapping by a consumer (e.g. an ESLint rule). */
export interface UnpassedProp {
  /** The external prop name (what a caller would pass). */
  name: string;
  start: number;
  end: number;
}

/**
 * Declared props that NO call site in the analyzed program ever passes — neither
 * explicitly (`<C p=…>` / `bind:p`), via a spread, nor as body content/`{#snippet}`.
 * These are "dead" from the consumer side: the component declares an input no one
 * supplies, so it is always its default. A lint-oriented counterpart to the
 * build-time fold (svelte-shaker would const-fold such a prop to its default).
 *
 * Soundness — only HIGH-CONFIDENCE reports, mirroring the folder's own caution:
 *  - a component that BAILED (escaped as a value, `accessors`, etc.) is skipped —
 *    its prop profile is unknowable;
 *  - a component with ZERO call sites is skipped — it is an entry/route/unused
 *    component whose props may be supplied OUTSIDE the analyzed graph (a SvelteKit
 *    `+page.svelte`'s `data`, a framework mount, a not-yet-rendered component);
 *  - a prop is reported only when EVERY call site neither names it nor carries a
 *    spread that could set it (`readCallSite` already folds `bind:`, known
 *    spreads, and `children`/snippet body into `explicit`/`hadSpread`);
 *  - a component in `input.escaped` — one the Shell knows has a consumer OUTSIDE
 *    the `.svelte` graph (a call site in a non-`.svelte` module, or a user
 *    `preserve`, docs §4.2) — is skipped, because that consumer may pass a prop
 *    the crawl cannot see.
 *
 * Missing a `.svelte` EDGE (e.g. an unfollowed barrel) only DROPS call sites, so it
 * can only make this UNDER-report (the component looks unused and is skipped). The
 * one way it could OVER-report is a consumer the crawl cannot parse at all — a
 * `.ts`/`.js` call site; `input.escaped` (the Shell's non-`.svelte` scan) closes
 * exactly that hole, so with it supplied the result stays false-positive-free.
 */
export function findNeverPassedProps(input: AnalyzeInput): Map<ComponentId, UnpassedProp[]> {
  const models = buildModels(input);
  // Stamp escape bails up front (same union as `analyzeInput`) so escaped
  // components are skipped below.
  stampEscapes(models);
  // Consumers outside the `.svelte` graph (non-`.svelte` module call sites or
  // `preserve`) escape too, so a prop they pass is never mis-reported as
  // never-passed (docs §4.2).
  stampModuleEscapes(models, input.escaped);

  // Every textual call site counts (no cascade dead-span filtering): a prop passed
  // only at a folded-away site is still author-written, so we do not flag it.
  const usage = buildUsage(models, new Map());

  const out = new Map<ComponentId, UnpassedProp[]>();
  for (const model of models.values()) {
    if (model.bailReasons.length > 0) continue;
    if (!model.props || model.props.length === 0) continue;
    const sites = usage.get(model.id)?.sites ?? [];
    if (sites.length === 0) continue;

    // Any spread at a live site could set any prop, so nothing here is provably
    // never-passed — skip the whole component in one test.
    if (sites.some((s) => s.hadSpread)) continue;
    // With no spread, a prop is passed iff some site names it explicitly.  Build the
    // union of explicitly-written names ONCE (O(props + sites)), not per-prop.
    const explicitlyPassed = new Set<string>();
    for (const site of sites) for (const name of site.explicit.keys()) explicitlyPassed.add(name);

    const unpassed: UnpassedProp[] = [];
    for (const decl of model.props) {
      if (explicitlyPassed.has(decl.name)) continue;
      unpassed.push({ name: decl.name, start: decl.property.start, end: decl.property.end });
    }
    if (unpassed.length > 0) out.set(model.id, unpassed);
  }
  return out;
}

/**
 * Remap a plan map keyed by EXTERNAL prop name (`constFold` / `narrow`) to one
 * keyed by the LOCAL binding name each prop introduces.  Call-site analysis and
 * call-site attribute dropping work off the external name (`prop` in `prop:
 * alias`), but every body/template reference uses the local name (`alias`), so
 * substitution, branch folding and CSS must look values up by local.  A prop in
 * `constFold`/`narrow` always has a single-identifier local by construction
 * ({@link buildPlan} never folds a `null`-local or shadowed prop), so every entry
 * maps cleanly; an external name with no matching declared local is dropped.
 */
export function remapToLocalNames<V>(map: Map<string, V>, model: FileModel): Map<string, V> {
  if (map.size === 0) return map; // common case: nothing folds — share the empty map
  const localByName = new Map<string, string>();
  for (const decl of model.props ?? []) {
    if (decl.local !== null) localByName.set(decl.name, decl.local);
  }
  const out = new Map<string, V>();
  for (const [name, value] of map) {
    const local = localByName.get(name);
    if (local !== undefined) out.set(local, value);
  }
  return out;
}

/**
 * Whether a declared prop name is unsafe to fold/narrow/drop because it is also
 * bound elsewhere: shadowed by a local `let`/`function` or a template binder
 * (`{#each as}`, snippet params, `{#await then}`, `let:`, `{@const}`), or used as
 * a `{@debug}` argument (Svelte forbids a literal there). In those scopes the
 * name is a different entity, so folding it would corrupt the binding (often
 * invalid Svelte) — or WRITTEN TO (reassigned / `++` / destructure-assigned /
 * `bind:`), in which case it is not a constant and folding it changes what
 * renders after the write. Both constant fold planning ({@link buildPlan}) and
 * monomorphization specialization (mono.ts) must honor this identically.
 */
export function isFoldBlockedName(model: FileModel, name: string): boolean {
  return (
    model.shadowedNames.has(name) || model.debugNames.has(name) || model.writtenNames.has(name)
  );
}

/** Decide what to fold for one component from its global usage. */
function buildPlan(model: FileModel, u: Usage | undefined, ownerEnv: OwnerEnv): ComponentPlan {
  const plan = emptyPlan(model.id);

  if (model.bailReasons.length > 0) {
    plan.bail = true;
    plan.reasons.push(...model.bailReasons);
    return plan;
  }
  if (!model.props || model.props.length === 0) return plan;
  // NOTE: a `...rest` in the *callee* never captures the callee's own declared
  // props — rest only holds UNDECLARED props (docs §4.1). So folding/dropping a
  // declared prop stays sound even when `...rest` exists; we do not bail here.
  const sites = u?.sites ?? [];
  if (sites.length === 0) return plan; // entry / unused: leave as-is

  for (const decl of model.props) {
    // A `null` local is a nested-pattern entry (`prop: { x }`): there is no single
    // identifier to substitute or drop, so it is never foldable — folding it would
    // delete the inner binding.  The shadow guard tests the LOCAL name (the entity
    // the body actually references): a name also bound elsewhere is a different
    // entity, so folding it corrupts that binding.  monomorphization specialization honors the
    // SAME two predicates (see mono.ts).
    if (decl.local === null || isFoldBlockedName(model, decl.local)) continue;

    const set = valueSetFor(decl, sites, ownerEnv);
    plan.valueSets.set(decl.name, set);

    // `top` (a spread may set it) and `dynamic` (a non-literal write) both
    // poison the set: the reachable values are not fully known, so neither
    // folding nor narrowing is sound.
    if (set.top || set.dynamic) continue;

    // constant fold: a clean singleton value set is the foldable case.
    if (set.values.length === 1) {
      const only = set.values[0]!;
      if (isFoldableValue(only)) plan.constFold.set(decl.name, only);
      continue;
    }
    // value-set narrowing: >= 2 distinct literals with no dynamic/⊤ contribution is a fully
    // known reachable value set — branches the prop can never reach are dead
    // (docs §3 value-set narrowing). The prop stays genuinely used, so it is only recorded for
    // narrowing, never for substitution/dropping.
    if (set.values.length >= 2) plan.narrow.set(decl.name, set.values);
  }
  return plan;
}
