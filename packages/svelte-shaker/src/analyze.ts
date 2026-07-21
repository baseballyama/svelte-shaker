import {
  parseCached,
  parseSvelte,
  walk,
  type AnyNode,
  type Parse,
  type ParseCache,
  type Root,
} from './parse.js';
import {
  emptyPlan,
  type AnalyzeInput,
  type ComponentId,
  type ComponentPlan,
  type InputFile,
  type Literal,
  type PropValueSet,
  type ResolvedEdge,
} from './ir.js';
import { computeDeadSpans, inSpans, type Span } from './dead.js';
import { evaluate, setVar, type EvalResult } from './eval.js';

export type Resolve = (
  source: string,
  importer: ComponentId,
) => Promise<ComponentId | null> | ComponentId | null;
export type ReadFile = (id: ComponentId) => Promise<string> | string;

/** Synchronous variants of {@link Resolve}/{@link ReadFile} for callers that
 * cannot await — e.g. an ESLint rule, which runs synchronously. Used by
 * {@link buildAnalyzeInputSync}. */
export type ResolveSync = (source: string, importer: ComponentId) => ComponentId | null;
export type ReadFileSync = (id: ComponentId) => string;

/**
 * The set of input names a child component can ever OBSERVE at runtime (docs
 * §PR4 reverse analysis).  In runes there is no `$$props`/`$$restProps`, so a
 * component reads an input only through its `$props()` destructure:
 *  - `{ kind: 'names' }` — a clean, rest-free ObjectPattern `$props()` (or no
 *    `$props()` at all, giving the empty set): the child can observe EXACTLY
 *    these declared external names, so a call-site input NOT in the set can
 *    never be seen and is safe to drop;
 *  - `{ kind: 'all' }` — anything we cannot pin down: a `...rest` (captures
 *    undeclared inputs), an Identifier/Array binding (`let p = $props()`),
 *    more than one `$props()` call, `$props()` outside a `let <pat> = …`
 *    declarator, or a component that observes slotted content outside `$props()`
 *    — a legacy `<slot>` element or a `$$slots` read (both legal in runes mode).
 *    Then any input might be observed, so nothing is dropped.
 */
export type ReachableInputs = { kind: 'all' } | { kind: 'names'; names: Set<string> };

/** One declared prop in a `$props()` destructuring. */
export interface PropDecl {
  /** The EXTERNAL prop name — the destructure KEY (`prop` in `prop: alias`).
   * Call sites pass this name, so value sets / dropping key off it. */
  name: string;
  /**
   * The LOCAL binding name the entry introduces in the body — the destructure
   * VALUE (`alias` in `prop: alias`, or the bare name for a shorthand `prop`),
   * or `null` when the entry binds a NESTED pattern (`prop: { x }`) rather than a
   * single identifier.  Body and template references use THIS name, not {@link
   * name}, so folding/substitution must look props up by it (`prop` and its alias
   * `alias` can even be different entities — e.g. a same-named import).  A `null`
   * local is never foldable: there is no single identifier to substitute or drop.
   */
  local: string | null;
  /** The `Property` node inside the `ObjectPattern` (for surgical removal). */
  property: AnyNode;
  /** Default value expression, if `name = <default>`. */
  defaultExpr?: AnyNode | undefined;
}

/** Everything we learn from parsing one component, reused by the transform. */
export interface FileModel {
  id: ComponentId;
  code: string;
  ast: Root;
  /**
   * Tag name a call site renders -> resolved child component id.  Holds every
   * attributable edge into this file: a bare local for a direct `.svelte`
   * default or a simple barrel/named import (`Sub`), and a dotted member for a
   * namespace render (`ns.Sub`).  {@link collectChildCalls} keys `<Tag .../>`
   * sites off this map, so every kind feeds the child's value set.
   */
  imports: Map<string, ComponentId>;
  /** Declared props, or `null` if the component has no `$props()` pattern. */
  props: PropDecl[] | null;
  /** The `let { ... } = $props()` declaration + its pattern, for editing. */
  propsDeclaration?: AnyNode | undefined;
  propsPattern?: AnyNode | undefined;
  hasRestProp: boolean;
  /**
   * The inputs this component can observe (docs §PR4).  Drives the reverse pass:
   * a call site of THIS component may drop an input outside {@link
   * ReachableInputs}.  Computed syntactically from the `$props()` shape.
   */
  reachableInputs: ReachableInputs;
  /**
   * EXTERNAL names of props this component DECLARES but never READS (docs §PR7):
   * destructured out of a clean `$props()` yet with zero value-position reference
   * to their local binding anywhere in the instance script or template.  Such a
   * prop is invisible to the child, so its call-site attribute is dead and — when
   * safe — the declaration can be dropped.  Source-only (independent of the call
   * sites), so it is computed ONCE here, never inside the fixpoint; the transform
   * gates its use on the component's plan not being bailed.
   */
  unreadDeclaredProps: Set<string>;
  /**
   * Every `<Child .../>` instance THIS component renders, with the child it
   * resolves to and the AST node (so the fixpoint can test whether the site
   * falls inside a dead `{#if}` span of this component — docs §2.1).
   */
  childCalls: ChildCall[];
  /**
   * Names this component binds OUTSIDE the `$props()` pattern — local `let` /
   * `function` declarations in the instance script, and every template-scope
   * binder (`{#each … as ctx, i}`, destructure patterns, `{#snippet name(p)}`,
   * `{#await … then v}` / `{:catch e}`, `let:` directives).  A declared prop
   * whose name collides with any of these is a DIFFERENT entity inside that
   * scope, so folding/substituting/dropping it would corrupt the binding (and
   * often produce invalid Svelte).  We therefore never fold such a prop.
   */
  shadowedNames: Set<string>;
  /**
   * Names that appear as a `{@debug …}` argument.  Svelte requires those to be
   * bare identifiers, so substituting a folded literal there is invalid and
   * dropping the prop dangles the reference — we never fold a prop named here.
   */
  debugNames: Set<string>;
  /**
   * Names the component WRITES TO — reassigns (`p = …`, `p += …`), mutates with
   * `++`/`--`, destructure-assigns (`({ p } = obj)`), or two-way `bind:`s.  A
   * written prop is not a constant even when every call site passes the same
   * literal: the write changes it at runtime, so folding it would substitute the
   * literal into the write's target (`"a" = …`, `0++`, `bind:value={"a"}`) —
   * invalid Svelte — and, more importantly, silently change what renders after
   * the write.  We never fold such a prop, exactly like a shadowed one.
   */
  writtenNames: Set<string>;
  /**
   * Owner-local bindings that are provably a single primitive CONSTANT, keyed by
   * the LOCAL name a forwarded call-site expression references (docs §13.1
   * interprocedural pass-through).  Merged into the owner's fold env so that
   * `<Child {count}/>` — where `count` is an unmutated `let count = $state(0)` or
   * a `const count = 0` — folds in the child exactly as a call-site literal would,
   * feeding BOTH constant fold and value-set narrowing.  A static property of the
   * source (independent of the fixpoint's plans), so it is computed ONCE here.
   * See {@link computeScriptConstEnv} for the (conservative) admission rules.
   */
  scriptConstEnv: ReadonlyMap<string, Literal>;
  /**
   * Resolved ids of CHILD components this file leaks as a value (escape, docs
   * §4.1) — e.g. `<svelte:component this={Child}>`.  `analyze` unions these
   * across the program and bails every escaped component completely, since its
   * prop profile can no longer be observed from `<Child .../>` sites alone.
   */
  escapedComponents: Set<ComponentId>;
  /** Reasons this whole component must be left untouched. */
  bailReasons: string[];
}

/** One `<Child .../>` instance rendered by a component. */
export interface ChildCall {
  childId: ComponentId;
  node: AnyNode;
}

/**
 * One value passed explicitly to a prop at one call site, after last-write-wins
 * has been resolved.  An explicit write is either a real attribute (`a={1}`) OR a
 * key expanded out of a statically-known object-literal spread (`{...{a:1}}`,
 * docs §4.1) — both name a prop and a value the same way.  `dynamic` means the
 * value is non-literal (`bind:`, a dynamic expression, or a spread key whose
 * value is non-literal): used, value not statically known.  `afterLastSpread`
 * records whether this write happened after the site's last *unknown* spread (one
 * we could not expand) — only then can no spread silently override it (docs §4.1,
 * "後勝ち順序で救う").  A known object-literal spread is expanded, not opaque, so
 * it never counts as an "unknown spread" here.
 */
export interface ExplicitProp {
  value: Literal;
  dynamic: boolean;
  afterLastSpread: boolean;
  /**
   * For a `dynamic` write whose value is a single expression (`prop={expr}`, or a
   * known-spread key `{...{prop: expr}}`), the raw expression node — kept so the
   * fixpoint can try to fold it against the OWNING component's constFold env
   * (interprocedural pass-through, docs §13.1).  Absent for a literal write, a
   * `bind:` (a two-way write that must never fold), or a multi-part value.
   */
  expr?: AnyNode | undefined;
}

/** How a child component is called at one `<Child .../>` site. */
export interface CallSite {
  /**
   * Did this site have at least one spread we could NOT statically expand (an
   * identifier / call / `{...{…computed/nested…}}`)?  A fully-known object-literal
   * spread is expanded into {@link ExplicitProp} writes instead, so it does not
   * set this — only an opaque spread, which may set any prop, does (docs §4.1).
   */
  hadSpread: boolean;
  /** Last-write-wins explicit props at this site, keyed by prop name. */
  explicit: Map<string, ExplicitProp>;
  /**
   * The component that OWNS this call site (renders the `<Child .../>`).  The
   * fixpoint uses it to evaluate a forwarded expression (`prop={ownerProp}`)
   * against the owner's fold env — interprocedural pass-through (docs §13.1).
   * `undefined` for callers that read a site outside the graph fixpoint (mono).
   */
  owner?: ComponentId | undefined;
}

/** Mutable accumulator of how a child component is called across the program. */
interface Usage {
  sites: CallSite[];
}

export interface AnalyzeResult {
  models: Map<ComponentId, FileModel>;
  plans: Map<ComponentId, ComponentPlan>;
}

const isSvelte = (source: string) => source.endsWith('.svelte');

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
  // profile, so it must be left completely untouched.  We union escapes across
  // every file and stamp a bail reason on each escaped component's model BEFORE
  // planning, so `buildPlan` bails it and the fixpoint never folds it.
  const escaped = new Set<ComponentId>();
  for (const model of models.values()) for (const id of model.escapedComponents) escaped.add(id);
  for (const id of escaped) {
    const model = models.get(id);
    if (model && !model.bailReasons.includes(ESCAPE_REASON)) model.bailReasons.push(ESCAPE_REASON);
  }
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
): Promise<AnalyzeInput> {
  const entryList = Array.isArray(entries) ? [...entries] : [entries];
  const files: InputFile[] = [];
  const edges: ResolvedEdge[] = [];
  const queue: ComponentId[] = [...entryList];
  const seen = new Set<ComponentId>(queue);

  while (queue.length > 0) {
    const id = queue.shift()!;
    const code = await readFile(id);
    files.push({ id, code });

    const ast = parseCached(id, code, parseCache, parse);
    const instance = ast.instance;
    if (!instance) continue;

    // The bare component tags this file renders (`<Local …>`). Resolving a barrel
    // (a `.js`/`.ts` re-export) means READING and PARSING the target module to
    // chase the export, so we do it ONLY for named imports actually rendered as a
    // component here — a named import used as a value (a helper / type) can never
    // be a `<Local>` call site, so chasing it is pure waste.
    const renderedTags = renderedComponentTagNames(ast);

    // Resolve this file's imports into the three attributable edge kinds.  Direct
    // default `.svelte` and simple barrel/named imports bind a bare local; a
    // namespace import (`import * as ns`) binds no single component, so it is
    // deferred to its rendered `<ns.X>` member tags below.
    const barrelLocals = new Map<string, ComponentId>();
    const namespaceSources = new Map<string, string>();
    const directChildren: ComponentId[] = [];
    for (const imp of importSources(instance)) {
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
      const childId = await resolveThroughBarrel(imp.value, imp.imported, id, resolve, readFile);
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
      for (const tag of memberComponentTags(ast)) {
        const dot = tag.indexOf('.');
        const source = namespaceSources.get(tag.slice(0, dot));
        if (source == null) continue;
        const childId = await resolveThroughBarrel(
          source,
          tag.slice(dot + 1),
          id,
          resolve,
          readFile,
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
 * Synchronous twin of {@link buildAnalyzeInput} for callers that cannot await
 * (an ESLint rule runs synchronously). Byte-for-byte the same crawl with sync
 * `resolve`/`readFile`; the `tests/build-analyze-input-sync` differential test
 * pins it identical to the async path, so keep the two bodies in lockstep.
 */
export function buildAnalyzeInputSync(
  entries: ComponentId | ComponentId[],
  resolve: ResolveSync,
  readFile: ReadFileSync,
  parseCache?: ParseCache,
  parse?: Parse,
  escaped: ComponentId[] = [],
): AnalyzeInput {
  const entryList = Array.isArray(entries) ? [...entries] : [entries];
  const files: InputFile[] = [];
  const edges: ResolvedEdge[] = [];
  const queue: ComponentId[] = [...entryList];
  const seen = new Set<ComponentId>(queue);

  while (queue.length > 0) {
    const id = queue.shift()!;
    const code = readFile(id);
    files.push({ id, code });

    const ast = parseCached(id, code, parseCache, parse);
    const instance = ast.instance;
    if (!instance) continue;

    // See {@link buildAnalyzeInput}: resolve a barrel only for named imports
    // actually rendered as a `<Local>` component here, to avoid reading+parsing
    // modules behind value-only named imports.
    const renderedTags = renderedComponentTagNames(ast);

    const barrelLocals = new Map<string, ComponentId>();
    const namespaceSources = new Map<string, string>();
    const directChildren: ComponentId[] = [];
    for (const imp of importSources(instance)) {
      if (imp.imported === '*') {
        namespaceSources.set(imp.local, imp.value);
        continue;
      }
      if (imp.imported === 'default' && isSvelte(imp.value)) {
        const childId = resolve(imp.value, id);
        if (childId) {
          edges.push({ from: id, local: imp.local, to: childId, kind: 'default-svelte' });
          directChildren.push(childId);
        }
        continue;
      }
      if (!renderedTags.has(imp.local)) continue;
      const childId = resolveThroughBarrelSync(imp.value, imp.imported, id, resolve, readFile);
      if (childId) {
        edges.push({ from: id, local: imp.local, to: childId, kind: 'barrel' });
        barrelLocals.set(imp.local, childId);
      }
    }

    const nsChildren: ComponentId[] = [];
    if (namespaceSources.size > 0) {
      for (const tag of memberComponentTags(ast)) {
        const dot = tag.indexOf('.');
        const source = namespaceSources.get(tag.slice(0, dot));
        if (source == null) continue;
        const childId = resolveThroughBarrelSync(source, tag.slice(dot + 1), id, resolve, readFile);
        if (childId) {
          edges.push({ from: id, local: tag, to: childId, kind: 'namespace' });
          nsChildren.push(childId);
        }
      }
    }

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

/**
 * The OWNER component's forwardable knowledge, both remapped to the LOCAL binding
 * names a forwarded expression references: `fold` collapses a prop to a single
 * literal (`constFold`), `narrow` holds a prop's known reachable value set
 * (`narrow`, >= 2 literals).  A bare owner-prop reference forwarded verbatim
 * (`<Child v={ownerProp}/>`) can propagate EITHER — the single value or the whole
 * set (docs §13.1).  `constFold` and `narrow` never share a name (buildPlan is
 * exclusive: singleton -> constFold, >= 2 -> narrow), so lookup order is immaterial.
 */
interface OwnerFoldEnv {
  fold: ReadonlyMap<string, Literal>;
  narrow: ReadonlyMap<string, Literal[]>;
}
/** {@link OwnerFoldEnv} for a given owner id (empty for `undefined` / a bailed owner). */
type OwnerEnv = (owner: ComponentId | undefined) => OwnerFoldEnv;

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
  const escaped = new Set<ComponentId>();
  for (const model of models.values()) for (const id of model.escapedComponents) escaped.add(id);
  for (const id of escaped) {
    const model = models.get(id);
    if (model && !model.bailReasons.includes(ESCAPE_REASON)) model.bailReasons.push(ESCAPE_REASON);
  }
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

    const unpassed: UnpassedProp[] = [];
    for (const decl of model.props) {
      const maybePassed = sites.some((s) => s.explicit.has(decl.name) || s.hadSpread);
      if (maybePassed) continue;
      const prop = decl.property as AnyNode;
      if (typeof prop.start !== 'number' || typeof prop.end !== 'number') continue;
      unpassed.push({ name: decl.name, start: prop.start, end: prop.end });
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

function buildModelFromInput(
  file: InputFile,
  edges: ResolvedEdge[],
  parseCache?: ParseCache,
): FileModel {
  const { id, code } = file;
  const ast = parseCached(id, code, parseCache);
  // Reconstruct the attribution map from the already-resolved edges (docs §2.1):
  // the engine never resolves.  Every edge kind is attributable — its `local` is
  // the exact tag a call site renders (a bare name for `default-svelte`/`barrel`,
  // a dotted member for `namespace`) — so all of them feed the value sets through
  // `collectChildCalls`.  The Shell already chased barrels/namespaces to the
  // `.svelte` they render, so there is no per-edge resolution or bail left here.
  const imports = new Map<string, ComponentId>();
  for (const edge of edges) imports.set(edge.local, edge.to);
  const bailReasons: string[] = [];

  // svelte:options accessors / customElement -> public props, never touchable.
  walk<null>(ast.fragment, null, {
    SvelteOptions(node, { next }) {
      for (const a of node.attributes ?? []) {
        if (a.type === 'Attribute' && (a.name === 'accessors' || a.name === 'customElement')) {
          bailReasons.push(`<svelte:options ${a.name}>`);
        }
      }
      next();
    },
  });

  let props: PropDecl[] | null = null;
  let propsDeclaration: AnyNode | undefined;
  let propsPattern: AnyNode | undefined;
  let hasRestProp = false;

  // Every imported local name (svelte or not) — needed for escape detection
  // below.  Resolution already happened in the Shell ({@link buildAnalyzeInput});
  // here we only read names off the parse, no IO.
  const importedLocals = new Set<string>();
  // Namespace import locals (`import * as ns`).  If `ns` itself is read as a value
  // the whole namespace object escapes, so every `ns.*` component it could render
  // must bail — `collectEscapedComponents` uses this to do so.
  const namespaceLocals = new Set<string>();
  const instance = ast.instance;
  if (instance) {
    for (const imp of importSources(instance)) {
      importedLocals.add(imp.local);
      if (imp.imported === '*') namespaceLocals.add(imp.local);
    }

    const found = findPropsDeclaration(instance);
    if (found) {
      propsDeclaration = found.declaration;
      propsPattern = found.pattern;
      // `let { x } = $props(), y = 1;` — the `$props()` destructuring is one of
      // several declarators in its statement.  Dropping the now-empty signature
      // removes the whole statement (it has no per-declarator anchor we edit),
      // which would delete the unrelated `y` binding and dangle its template
      // reference.  This is rare; bail the whole component conservatively rather
      // than risk corrupting sibling declarations (docs §4.1: when unsure, leave
      // it).  The empty `dropped` set then also leaves call-site attributes in
      // place.
      if (found.sharesStatement) bailReasons.push('$props() shares a multi-declarator statement');
      props = [];
      for (const p of found.pattern.properties ?? []) {
        if (p.type === 'RestElement') {
          hasRestProp = true;
          continue;
        }
        if (p.type !== 'Property') continue;
        const key = p.key;
        if (key?.type !== 'Identifier' || !key.name) continue;
        // The destructure VALUE is the local binding.  A bare identifier (`prop`
        // shorthand, or `prop: alias`) binds that one name; an `AssignmentPattern`
        // (`prop = d` / `prop: alias = d`) binds its LEFT and carries the default;
        // anything else (a nested Object/Array pattern, with or without default)
        // binds no single identifier, so `local` is `null` and the prop is never
        // foldable.
        const value = p.value as AnyNode | undefined;
        let local: string | null = null;
        let defaultExpr: AnyNode | undefined;
        if (value?.type === 'Identifier') {
          local = value.name ?? null;
        } else if (value?.type === 'AssignmentPattern') {
          defaultExpr = value.right;
          if (value.left?.type === 'Identifier') local = value.left.name ?? null;
        }
        props.push({ name: key.name, local, property: p, defaultExpr });
      }
    }
  }

  const reachableInputs = computeReachableInputs(
    instance,
    props,
    hasRestProp,
    propsPattern,
    usesLegacySlotInputs(ast),
  );
  const childCalls = collectChildCalls(ast, imports);
  const { shadowedNames, debugNames, writtenNames } = collectTemplateBindings(
    ast,
    instance,
    propsDeclaration,
  );
  const unreadDeclaredProps = computeUnreadDeclaredProps(
    ast,
    instance,
    props,
    propsPattern,
    shadowedNames,
    debugNames,
    writtenNames,
  );
  const scriptConstEnv = computeScriptConstEnv(
    ast,
    instance,
    ast.module,
    propsDeclaration,
    writtenNames,
  );

  // Escape detection (docs §4.1): an imported component referenced as a *value*
  // (most notably `<svelte:component this={X}>`, but also assigned / passed /
  // stored) leaks to a use we cannot follow, so its prop profile is incomplete.
  // We surface that to the OWNING component of the escaped child via
  // `escapedComponents`; `analyze` turns it into a complete bail for that child.
  const escapedComponents = collectEscapedComponents(ast, imports, importedLocals, namespaceLocals);

  return {
    id,
    code,
    ast,
    imports,
    props,
    propsDeclaration,
    propsPattern,
    hasRestProp,
    reachableInputs,
    unreadDeclaredProps,
    childCalls,
    shadowedNames,
    debugNames,
    writtenNames,
    scriptConstEnv,
    escapedComponents,
    bailReasons,
  };
}

/**
 * EXTERNAL names of props DECLARED but never READ (docs §PR7).  A declared prop
 * `p` (local binding `l`) is unread when NO value-position reference to `l`
 * survives anywhere in the instance script or template — reusing the escape
 * scan's own `isValueUse` + `isTypeOnlyNode` prune, so TS type positions (erased
 * at compile) do not count as reads.  Its own declaration positions in the
 * `$props()` pattern are excluded, but default expressions ARE scanned (a `{ a, b
 * = a }` reads `a`).  Conservative — a prop is treated as read (kept) when:
 *  - the `$props()` shape is not a clean single-call ObjectPattern (a non-object
 *    binding, or a SECOND `$props()` call whose alias could re-read it via
 *    member access we do not track), or
 *  - it binds a nested pattern (no single local identifier), or
 *  - its local is shadowed / written / a `{@debug}` argument ({@link
 *    isFoldBlockedName}), where the reference's identity is ambiguous.
 */
function computeUnreadDeclaredProps(
  ast: Root,
  instance: AnyNode | null | undefined,
  props: PropDecl[] | null,
  propsPattern: AnyNode | undefined,
  shadowedNames: Set<string>,
  debugNames: Set<string>,
  writtenNames: Set<string>,
): Set<string> {
  if (!instance || !props || props.length === 0) return new Set();
  // A second `$props()` call can alias the props object (`const all = $props()`)
  // and read a prop via `all.p`, which the local-name scan below cannot see — so
  // only a single, clean `$props()` call is eligible.  A `...rest` is fine: it
  // never captures a DECLARED prop, so it cannot re-expose one we drop.
  if (countPropsCalls(instance) !== 1) return new Set();

  const externalByLocal = new Map<string, string>();
  for (const decl of props) {
    if (decl.local === null) continue; // nested pattern: no single identifier
    if (shadowedNames.has(decl.local) || debugNames.has(decl.local) || writtenNames.has(decl.local))
      continue;
    externalByLocal.set(decl.local, decl.name);
  }
  if (externalByLocal.size === 0) return new Set();

  // The identifier nodes that are DECLARATIONS in the `$props()` pattern (each
  // property's key and its local binding), so the scan below does not count them
  // as reads.  Default expressions are NOT excluded — they are real reads.
  const declIdents = new Set<AnyNode>();
  for (const p of propsPattern?.properties ?? []) {
    if (p.type !== 'Property') continue;
    if (p.key) declIdents.add(p.key);
    const value = p.value as AnyNode | undefined;
    if (value?.type === 'Identifier') declIdents.add(value);
    else if (value?.type === 'AssignmentPattern' && value.left?.type === 'Identifier')
      declIdents.add(value.left);
  }

  const readLocals = new Set<string>();
  const scan = (root: AnyNode | null | undefined): void => {
    if (!root) return;
    walk<{ parent: AnyNode | null }>(
      root,
      { parent: null },
      {
        _(node, { state, next }) {
          if (isTypeOnlyNode(node)) return; // TS type positions are erased, never reads
          if (
            node.type === 'Identifier' &&
            node.name &&
            externalByLocal.has(node.name) &&
            !declIdents.has(node) &&
            isValueUse(node, state.parent)
          ) {
            readLocals.add(node.name);
          }
          next({ parent: node });
        },
      },
    );
  };
  scan(instance);
  scan(ast.fragment);

  const unread = new Set<string>();
  for (const [local, name] of externalByLocal) {
    if (!readLocals.has(local)) unread.add(name);
  }
  return unread;
}

/**
 * Owner-local, provably-constant primitive bindings, keyed by the LOCAL name a
 * forwarded call-site expression references (docs §13.1 interprocedural
 * pass-through).  Walks the module then the instance `<script>`'s TOP-LEVEL
 * declarations in order, extending the env sequentially so `const a = 1; const b
 * = a + 1;` both resolve.  Every rule is conservative for soundness — a binding
 * is admitted ONLY when its identifier definitely denotes one constant primitive
 * at every call site:
 *  - `const x = <expr>` / `let|var x = <expr>` whose `<expr>` constant-evaluates
 *    against the env built so far;
 *  - `$state(<arg>)` / `$state.raw(<arg>)` are unwrapped to `<arg>` (a bare
 *    `$state()` is `undefined`): the reactive wrapper does not change the value a
 *    never-written binding forwards.  `$derived` / `$props` / any OTHER rune is
 *    not unwrapped, so its `CallExpression` never constant-evaluates and is
 *    skipped (out of scope);
 *  - primitives only — the `Literal` domain excludes object/array initializers,
 *    so deep mutation through a `$state` proxy can never be folded away;
 *  - the name is NEVER written (reassigned / `++` / destructure-assigned /
 *    `bind:`), tested against {@link writtenNames} extended with module-internal
 *    writes (docs §4.1: a written binding is not a constant);
 *  - the name is bound EXACTLY ONCE across the whole file (its own top-level
 *    declarator).  A name a template binder (`{#each as}`, snippet param, …) or a
 *    nested/duplicate scope also binds is a DIFFERENT entity at some call site,
 *    and call-site evaluation ({@link evaluate}) is scope-blind, so folding it
 *    could read the wrong entity there (docs §4.1 shadowing; the same soundness
 *    argument as {@link isFoldBlockedName}, but on the owner's OWN bindings — for
 *    which the file-wide `shadowedNames` cannot be reused: it already contains
 *    every top-level script declaration, so it would reject every candidate);
 *  - exported bindings (`export const x`) are excluded — they are wrapped in an
 *    `ExportNamedDeclaration`, not a bare `VariableDeclaration`, so the top-level
 *    scan below skips them; like an escaped component they are reachable from
 *    outside the analyzed graph.
 */
function computeScriptConstEnv(
  ast: Root,
  instance: AnyNode | null | undefined,
  moduleScript: AnyNode | null | undefined,
  propsDeclaration: AnyNode | undefined,
  writtenNames: Set<string>,
): Map<string, Literal> {
  const env = new Map<string, Literal>();

  // A name is admissible only if bound EXACTLY ONCE anywhere in the file, so no
  // template binder or nested scope can shadow it at a call site.
  const bindingCounts = new Map<string, number>();
  countBindingNames(moduleScript?.content, bindingCounts);
  countBindingNames(instance?.content, bindingCounts);
  countBindingNames(ast.fragment, bindingCounts);

  // `writtenNames` (from collectTemplateBindings) scans the instance script and
  // the template but NOT the module script, so a module-internal write
  // (`<script module>let n = 0; function inc(){ n++ }</script>`) would be missed.
  // Close that gap here before admitting any module-level binding.
  const written = new Set(writtenNames);
  collectScriptWrites(moduleScript?.content, written);

  // Module script runs before the instance and its bindings are visible to it,
  // so extend module-first, then instance, each in declaration order.
  for (const program of [moduleScript?.content, instance?.content]) {
    for (const stmt of program?.body ?? []) {
      // Only a bare `VariableDeclaration`; an `export const` is wrapped in an
      // `ExportNamedDeclaration` and is deliberately excluded (see doc comment).
      if (stmt.type !== 'VariableDeclaration' || stmt === propsDeclaration) continue;
      for (const decl of stmt.declarations ?? []) {
        // A single-identifier binding only: a destructuring `const { a } = …`
        // has no one primitive name to key, so it never folds.
        if (decl.id?.type !== 'Identifier' || !decl.id.name) continue;
        const name = decl.id.name;
        if (written.has(name) || bindingCounts.get(name) !== 1) continue;
        const value = evalDeclaratorValue(decl.init, env);
        if (value.known) env.set(name, value.value);
      }
    }
  }
  return env;
}

/**
 * Constant value of a declarator initializer for {@link computeScriptConstEnv},
 * unwrapping the two runes whose argument IS the value a never-written binding
 * holds: `$state(<arg>)` / `$state.raw(<arg>)` (a bare `$state()` /
 * `$state.raw()` is `undefined`).  Any other initializer — including every other
 * rune call — is evaluated verbatim, so a non-value rune simply falls to unknown.
 */
function evalDeclaratorValue(
  init: AnyNode | undefined,
  env: ReadonlyMap<string, Literal>,
): EvalResult {
  if (isStateRuneCall(init)) {
    const arg = init?.arguments?.[0];
    if (arg == null) return { known: true, value: undefined }; // bare `$state()` -> undefined
    return evaluate(arg, env);
  }
  return evaluate(init, env);
}

/**
 * `$state(...)` or `$state.raw(...)` — the two runes whose sole argument is the
 * plain value a never-written binding evaluates to.  `$state.snapshot`,
 * `$derived`, `$props`, `$bindable`, etc. are intentionally NOT matched: they are
 * not value-preserving wrappers, so they must stay unknown.
 */
function isStateRuneCall(node: AnyNode | undefined): boolean {
  if (node?.type !== 'CallExpression') return false;
  const callee = node.callee;
  if (callee?.type === 'Identifier') return callee.name === '$state';
  return (
    callee?.type === 'MemberExpression' &&
    callee.computed !== true &&
    callee.object?.type === 'Identifier' &&
    callee.object.name === '$state' &&
    callee.property?.type === 'Identifier' &&
    callee.property.name === 'raw'
  );
}

/**
 * Increment `counts` for every name a binding introduces in `root` (a `<script>`
 * Program or the template fragment): variable declarators (including
 * destructuring), function ids and parameters, and every template binder
 * ({@link collectTemplateBindings} covers the same binders).  A name whose total
 * count exceeds one is bound in more than one place — a nested/duplicate
 * declaration or a template binder — so it is shadowed at some scope and is
 * disqualified from {@link computeScriptConstEnv}.
 */
function countBindingNames(root: AnyNode | null | undefined, counts: Map<string, number>): void {
  if (!root) return;
  const bump = (name: string | undefined): void => {
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  };
  const bumpPattern = (pattern: AnyNode | null | undefined): void => {
    const names = new Set<string>();
    addPatternNames(pattern, names);
    for (const n of names) bump(n);
  };
  // A `try {} catch (e) {}` param is intentionally NOT counted: a call-site
  // expression only resolves against the TOP-LEVEL script scope, which a
  // catch-block-scoped name can never enter, so it cannot shadow a fold there.
  walk<null>(root, null, {
    _(node, { next }) {
      switch (node.type) {
        case 'VariableDeclarator':
          bumpPattern(node.id);
          break;
        case 'FunctionDeclaration':
        case 'FunctionExpression':
        case 'ArrowFunctionExpression':
          if (node.id?.type === 'Identifier') bump(node.id.name);
          for (const p of node.params ?? []) bumpPattern(p);
          break;
        case 'EachBlock':
          bumpPattern(node.context);
          if (typeof node.index === 'string') bump(node.index);
          break;
        case 'SnippetBlock':
          if (node.expression?.type === 'Identifier') bump(node.expression.name);
          for (const p of node.parameters ?? []) bumpPattern(p);
          break;
        case 'AwaitBlock':
          bumpPattern(node.value as AnyNode | undefined);
          bumpPattern(node.error);
          break;
        case 'LetDirective':
          bump(node.name);
          break;
        case 'ConstTag':
          for (const d of node.declaration?.declarations ?? []) bumpPattern(d.id);
          break;
      }
      next();
    },
  });
}

/** Add every name a `<script>` Program WRITES (bare-identifier assignment /
 * update targets, at any nesting) to `out` — the module-script counterpart of
 * the write collection {@link collectTemplateBindings} runs over the instance. */
function collectScriptWrites(program: AnyNode | null | undefined, out: Set<string>): void {
  if (!program) return;
  walk<null>(program, null, {
    AssignmentExpression(node, { next }) {
      collectWrittenNames(node, out);
      next();
    },
    UpdateExpression(node, { next }) {
      collectWrittenNames(node, out);
      next();
    },
  });
}

/**
 * Collect every name bound by a TEMPLATE scope (so a same-named prop is a
 * different entity there) and every name used as a `{@debug}` argument.
 *
 * The instance-script `let`/`function` shadows handled by the old
 * {@link referencedAsBinding} are folded in here too, so one set answers "is
 * this prop name rebound anywhere we'd otherwise wrongly substitute it?".
 *
 * Template binders covered: `{#each expr as ctx, index (key)}` (`ctx` may be a
 * destructure pattern), `{#snippet name(params)}`, `{#await expr then value}` /
 * `{:catch error}`, and `let:foo` directives.  All of these introduce bindings
 * the transform's substitution pass is otherwise blind to.
 */
function collectTemplateBindings(
  ast: Root,
  instance: AnyNode | null | undefined,
  propsDeclaration: AnyNode | undefined,
): { shadowedNames: Set<string>; debugNames: Set<string>; writtenNames: Set<string> } {
  const shadowedNames = new Set<string>();
  const debugNames = new Set<string>();
  const writtenNames = new Set<string>();

  // Instance-script `let` / `function` shadows (the original guard's job).
  if (instance) {
    walk<null>(instance, null, {
      _(node, { next }) {
        if (
          (node.type === 'VariableDeclarator' || node.type === 'FunctionDeclaration') &&
          node !== propsDeclaration &&
          node.id?.type === 'Identifier' &&
          node.id.name
        ) {
          shadowedNames.add(node.id.name);
        }
        // Function / arrow PARAMETERS rebind their names inside the callback
        // body, so a prop sharing a parameter name is a DIFFERENT entity there.
        // Substituting the prop's literal into the parameter slot emits invalid
        // Svelte (`(x) =>` -> `(1) =>` "Assigning to rvalue") and corrupts any
        // shadowed body reference. The destructure/`{#each as}`/snippet-param
        // guard never covered these, so collect them here and bail such props.
        if (
          node.type === 'FunctionDeclaration' ||
          node.type === 'FunctionExpression' ||
          node.type === 'ArrowFunctionExpression'
        ) {
          for (const param of node.params ?? []) addPatternNames(param, shadowedNames);
        }
        collectWrittenNames(node, writtenNames);
        next();
      },
    });
  }

  walk<null>(ast.fragment, null, {
    // Writes also live in the template: event handlers (`onclick={() => p = 1}`)
    // and `bind:` directives both reassign their target.
    BindDirective(node, { next }) {
      // `bind:value={p}` / `bind:this={el}` writes back to `p`.  A member target
      // (`bind:value={o.x}`) is an object mutation, not a scalar-prop rebind, so
      // it is not collected — matching the assignment handling below.
      if (node.expression?.type === 'Identifier' && node.expression.name)
        writtenNames.add(node.expression.name);
      next();
    },
    AssignmentExpression(node, { next }) {
      collectWrittenNames(node, writtenNames);
      next();
    },
    UpdateExpression(node, { next }) {
      collectWrittenNames(node, writtenNames);
      next();
    },
    EachBlock(node, { next }) {
      addPatternNames(node.context, shadowedNames);
      if (typeof node.index === 'string') shadowedNames.add(node.index);
      next();
    },
    SnippetBlock(node, { next }) {
      // The snippet NAME itself is a binding, and so is every parameter.
      if (node.expression?.type === 'Identifier' && node.expression.name)
        shadowedNames.add(node.expression.name);
      for (const p of node.parameters ?? []) addPatternNames(p, shadowedNames);
      next();
    },
    AwaitBlock(node, { next }) {
      // `then` value / `catch` error bindings (`value` is the loose `unknown`).
      addPatternNames(node.value as AnyNode | undefined, shadowedNames);
      addPatternNames(node.error, shadowedNames);
      next();
    },
    LetDirective(node, { next }) {
      // `let:foo` binds `foo` (or `let:foo={value}` re-binds it) in the slot.
      if (node.name) shadowedNames.add(node.name);
      next();
    },
    ConstTag(node, { next }) {
      // `{@const x = …}` binds `x`; treat it as a shadow too.
      for (const d of node.declaration?.declarations ?? []) addPatternNames(d.id, shadowedNames);
      next();
    },
    DebugTag(node, { next }) {
      for (const ident of node.identifiers ?? [])
        if (ident.type === 'Identifier' && ident.name) debugNames.add(ident.name);
      next();
    },
  });

  return { shadowedNames, debugNames, writtenNames };
}

/**
 * Add the names an assignment / update expression WRITES to `out`.  Handles a
 * bare-identifier target (`p = …`, `p += …`, `p++`) and a destructuring
 * assignment (`({ p } = obj)`, `[p] = xs`) via {@link addPatternNames}.  A
 * MemberExpression target (`o.x = …`, `o.x++`) is an object mutation, not a
 * scalar-prop rebind, so it is intentionally skipped (`addPatternNames` ignores
 * it), matching the fold targets this guard protects.
 */
function collectWrittenNames(node: AnyNode, out: Set<string>): void {
  if (node.type === 'AssignmentExpression') addPatternNames(node.left, out);
  else if (node.type === 'UpdateExpression' && node.argument?.type === 'Identifier') {
    if (node.argument.name) out.add(node.argument.name);
  }
}

/**
 * Add every identifier bound by a (possibly destructuring) pattern to `out`.
 * Handles bare identifiers, object/array destructuring, defaults and rest.
 */
function addPatternNames(pattern: AnyNode | null | undefined, out: Set<string>): void {
  if (!pattern) return;
  switch (pattern.type) {
    case 'Identifier':
      if (pattern.name) out.add(pattern.name);
      return;
    case 'ObjectPattern':
      for (const prop of pattern.properties ?? []) {
        if (prop.type === 'RestElement') addPatternNames(prop.argument, out);
        // `{ a }` / `{ a: b }` — the binding is the property *value*.
        else if (prop.type === 'Property')
          addPatternNames((prop.value as AnyNode) ?? prop.key, out);
      }
      return;
    case 'ArrayPattern':
      for (const el of pattern.elements ?? []) addPatternNames(el, out);
      return;
    case 'AssignmentPattern':
      addPatternNames(pattern.left, out);
      return;
    case 'RestElement':
      addPatternNames(pattern.argument, out);
      return;
    default:
      return;
  }
}

/**
 * Imported component ids that ESCAPE — referenced as a value rather than only as
 * a `<Comp .../>` element name.  The dominant case is `<svelte:component
 * this={X}>`, where `X` is an ordinary identifier read of the import; once a
 * component leaks like this we can no longer see all the props it receives, so
 * the owner reports it and `analyze` bails the child completely (docs §4.1).
 *
 * We only flag a NAME we resolved to a `.svelte` import.  Normal `<X .../>`
 * usage parses as a `Component` whose `name` is a string (not an Identifier
 * node), so it never counts as an escape.
 */
function collectEscapedComponents(
  ast: Root,
  imports: Map<string, ComponentId>,
  importedLocals: Set<string>,
  namespaceLocals: Set<string>,
): Set<ComponentId> {
  const escaped = new Set<ComponentId>();
  const flag = (name: string | undefined) => {
    if (!name) return;
    const childId = imports.get(name);
    if (childId) escaped.add(childId);
    // A namespace object (`import * as ns`) read as a value can render any of its
    // members dynamically (`const C = ns.X; <svelte:component this={C}/>`), so
    // every `ns.*` component we resolved must bail too.
    if (namespaceLocals.has(name)) {
      for (const [local, id] of imports) if (local.startsWith(`${name}.`)) escaped.add(id);
    }
  };

  walk<{ parent: AnyNode | null }>(
    ast.fragment,
    { parent: null },
    {
      _(node, { state, next }) {
        // Type-only subtrees are erased at compile — never a runtime escape.
        if (isTypeOnlyNode(node)) return;
        if (
          node.type === 'Identifier' &&
          node.name &&
          importedLocals.has(node.name) &&
          isValueUse(node, state.parent)
        ) {
          flag(node.name);
        }
        next({ parent: node });
      },
    },
  );

  // The instance script can also leak a component as a value (assign to a var,
  // push into an array, pass to a function, store in a `$state`, etc.).
  if (ast.instance) {
    walk<{ parent: AnyNode | null }>(
      ast.instance,
      { parent: null },
      {
        _(node, { state, next }) {
          // Skip TS type positions: an identifier in `ComponentProps<typeof X>`
          // or `: Props` is type-level (erased at compile), not a value read, so
          // descending would falsely flag the component as escaped.
          if (isTypeOnlyNode(node)) return;
          if (
            node.type === 'Identifier' &&
            node.name &&
            (imports.has(node.name) || namespaceLocals.has(node.name)) &&
            isValueUse(node, state.parent) &&
            !isImportSpecifierPosition(state.parent)
          ) {
            flag(node.name);
          }
          next({ parent: node });
        },
      },
    );
  }

  return escaped;
}

/**
 * A TS type-only subtree the escape walk must NOT descend into: every `TSType*`
 * node (type annotations, type references/queries, type-argument and
 * type-parameter lists, …) plus `interface` declarations.  Identifiers inside
 * them — e.g. `Button` in `ComponentProps<typeof Button>['pattern']`, or `Props`
 * in `: Props` — are type-level, erased at compile, never runtime value reads, so
 * descending would falsely flag the component as escaped and bail it whole.
 *
 * `TSAsExpression` / `TSSatisfiesExpression` / `TSNonNullExpression` /
 * `TSInstantiationExpression` are deliberately NOT pruned: they wrap a real
 * runtime expression (`Button as T` IS a value use of `Button`), and their own
 * type child is itself a `TSType*` node this prunes.
 */
function isTypeOnlyNode(node: AnyNode): boolean {
  return (
    typeof node.type === 'string' &&
    (node.type.startsWith('TSType') || node.type === 'TSInterfaceDeclaration')
  );
}

/**
 * Is this Identifier used as a runtime *value* (so a component name here would
 * escape)?  Property keys, member names and import/export specifier slots are
 * not value reads; everything else conservatively counts as one.
 */
function isValueUse(node: AnyNode, parent: AnyNode | null): boolean {
  if (!parent) return false;
  if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed)
    return false;
  if (
    parent.type === 'Property' &&
    parent.key === node &&
    !parent.computed &&
    parent.shorthand !== true
  )
    return false;
  if (isImportSpecifierPosition(parent)) return false;
  return true;
}

function isImportSpecifierPosition(parent: AnyNode | null): boolean {
  return (
    parent != null &&
    (parent.type === 'ImportSpecifier' ||
      parent.type === 'ImportDefaultSpecifier' ||
      parent.type === 'ImportNamespaceSpecifier' ||
      parent.type === 'ExportSpecifier')
  );
}

/** Every `<Child .../>` this component renders, paired with its resolved id. */
function collectChildCalls(ast: Root, imports: Map<string, ComponentId>): ChildCall[] {
  const calls: ChildCall[] = [];
  walk<null>(ast.fragment, null, {
    Component(node, { next }) {
      const childId = node.name ? imports.get(node.name) : undefined;
      if (childId) calls.push({ childId, node });
      next();
    },
  });
  return calls;
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
function renderedComponentTagNames(ast: Root): Set<string> {
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
function memberComponentTags(ast: Root): Set<string> {
  const tags = new Set<string>();
  walk<null>(ast.fragment, null, {
    Component(node, { next }) {
      if (typeof node.name === 'string' && node.name.includes('.')) tags.add(node.name);
      next();
    },
  });
  return tags;
}

/**
 * Read one `<Child .../>` into a {@link CallSite}.  Attributes are in source
 * order, so we resolve last-write-wins (a later `a={…}` overrides an earlier
 * one) and record, per prop, whether its winning write came *after* the last
 * *unknown* spread — the only case a spread cannot silently override it (docs
 * §4.1).  A statically-known object-literal spread (`{...{a:1, b:2}}`) is not
 * opaque: we expand its keys into explicit writes at the spread's position, so it
 * both contributes those literals AND does not poison props it cannot set (docs
 * §4.1, "{...obj} が object literal ならキー展開").
 */
export function readCallSite(component: AnyNode, owner?: ComponentId): CallSite {
  const attrs = component.attributes ?? [];
  // Only spreads we CANNOT expand are opaque (may set any prop).  Classify first
  // so `afterLastSpread` is measured against the last *unknown* spread, not a
  // known object literal we are about to expand into explicit writes.
  let lastSpreadIndex = -1;
  for (let i = 0; i < attrs.length; i++) {
    const attr = attrs[i]!;
    if (attr.type === 'SpreadAttribute' && knownSpreadEntries(attr) === null) lastSpreadIndex = i;
  }

  const explicit = new Map<string, ExplicitProp>();
  for (let i = 0; i < attrs.length; i++) {
    const attr = attrs[i]!;
    if (attr.type === 'SpreadAttribute') {
      // A known object-literal spread expands to one explicit write per key, at
      // this spread's position; an unknown spread is opaque and handled by the
      // `hadSpread`/`afterLastSpread` poisoning in `valueSetFor`.
      const entries = knownSpreadEntries(attr);
      if (entries) {
        for (const [name, value] of entries) {
          explicit.set(
            name,
            value.known
              ? { value: value.value, dynamic: false, afterLastSpread: i > lastSpreadIndex }
              : dynamicWrite(i, lastSpreadIndex, value.expr),
          );
        }
      }
      continue;
    }
    const name = attr.name;
    if (attr.type === 'BindDirective') {
      // `bind:prop` is a used, dynamic two-way binding (docs §4.1).
      if (name) explicit.set(name, dynamicWrite(i, lastSpreadIndex));
      continue;
    }
    if (attr.type !== 'Attribute' || !name) continue; // on:/use:/let: are not props
    const lit = literalAttrValue(attr.value);
    // Last-write-wins: a later occurrence of the same name overrides earlier.
    explicit.set(
      name,
      lit.known
        ? {
            value: lit.value,
            dynamic: false,
            afterLastSpread: i > lastSpreadIndex,
          }
        : dynamicWrite(i, lastSpreadIndex, singleExprValue(attr.value)),
    );
  }

  // Svelte 5 synthesizes props from the component's element BODY, not from
  // attributes (docs §4.2: every consumer of a prop must be enumerated):
  //  - any non-whitespace, non-comment, non-`{#snippet}` body content sets the
  //    `children` prop, and
  //  - each `{#snippet name(...)}` in the body sets a prop named `name`.
  // These are real (dynamic) writes the attribute scan above is blind to; if we
  // omitted them, a `children`/named-snippet prop with no attribute would fall
  // back to its default, fold to a constant, and the transform would erase the
  // slotted content.  Mark each as a dynamic write that no spread can override
  // (it is supplied positionally, after any spread), so the prop is never folded
  // or dropped.  This is conservative — it only ever keeps such a prop.
  for (const name of synthesizedBodyProps(component)) {
    explicit.set(name, dynamicWrite(attrs.length, lastSpreadIndex));
  }

  return { hadSpread: lastSpreadIndex >= 0, explicit, owner };
}

/**
 * The single expression node behind a non-literal attribute value
 * (`prop={expr}`), or `undefined` when the value is a boolean shorthand, a plain
 * text run, or a multi-part text/expression concatenation.  Only a lone
 * `ExpressionTag` yields a node the fixpoint can fold against the owner env; a
 * concatenation has no single expression, so it stays dynamic.
 */
function singleExprValue(value: unknown): AnyNode | undefined {
  if (value === true || value == null) return undefined;
  const parts = (Array.isArray(value) ? value : [value]) as AnyNode[];
  if (parts.length === 1 && parts[0]!.type === 'ExpressionTag') {
    return (parts[0]!.expression as AnyNode | undefined) ?? undefined;
  }
  return undefined;
}

/**
 * Names of the props a `<Child>…</Child>` call site supplies through its element
 * body rather than through attributes: `children` for any renderable body
 * content, plus one entry per named `{#snippet name(...)}` block.  Matches
 * Svelte's own rule — pure whitespace and comments do NOT synthesize `children`
 * (verified against the compiler), so a multi-line self-closing-style body does
 * not spuriously keep `children`.
 */
function synthesizedBodyProps(component: AnyNode): string[] {
  const nodes = component.fragment?.nodes ?? [];
  const names: string[] = [];
  let hasChildren = false;
  for (const node of nodes) {
    if (node.type === 'SnippetBlock') {
      // `{#snippet header()}` supplies the `header` prop.
      if (node.expression?.type === 'Identifier' && node.expression.name)
        names.push(node.expression.name);
      continue;
    }
    if (node.type === 'Comment') continue;
    if (node.type === 'Text') {
      // Whitespace-only text does not synthesize `children`.
      const text = (node.data ?? node.raw ?? '') as string;
      if (text.trim() === '') continue;
    }
    hasChildren = true;
  }
  if (hasChildren) names.push('children');
  return names;
}

function dynamicWrite(index: number, lastSpreadIndex: number, expr?: AnyNode): ExplicitProp {
  return {
    value: undefined,
    dynamic: true,
    afterLastSpread: index > lastSpreadIndex,
    expr,
  };
}

/**
 * The `[name, value]` entries a spread contributes IF it is a statically-known
 * object literal whose complete key set we can see (docs §4.1 "object literal な
 * spread はキー展開").  Returns `null` for any spread we cannot fully expand — an
 * identifier/call (`{...rest}`), or an object literal carrying a nested spread
 * (`{...{...x}}`), a computed key (`{...{[k]: 1}}`), or a getter/setter/method —
 * because then we do not know the full set of props it sets and must treat it as
 * opaque.  Each entry's value is `{known:true,value}` for a literal (so it folds)
 * or `{known:false}` for a non-literal value (key known, value dynamic): both are
 * sound, since the key set is fully known either way.
 */
function knownSpreadEntries(
  attr: AnyNode,
): Array<
  [string, { known: true; value: Literal } | { known: false; expr?: AnyNode | undefined }]
> | null {
  const obj = attr.expression;
  if (obj?.type !== 'ObjectExpression') return null;
  const entries: Array<
    [string, { known: true; value: Literal } | { known: false; expr?: AnyNode | undefined }]
  > = [];
  for (const prop of obj.properties ?? []) {
    // A nested spread, computed key, or accessor/method means the full key set is
    // not statically knowable -> the whole spread is opaque.
    if (prop.type !== 'Property') return null;
    if (
      prop.computed === true ||
      prop.kind === 'get' ||
      prop.kind === 'set' ||
      prop.method === true
    )
      return null;
    const key = prop.key;
    const name =
      key?.type === 'Identifier'
        ? key.name
        : key?.type === 'Literal' &&
            (typeof key.value === 'string' || typeof key.value === 'number')
          ? String(key.value)
          : null;
    if (name == null) return null;
    entries.push([name, evalToLiteral(prop.value as AnyNode | undefined)]);
  }
  return entries;
}

/** Constant-evaluate a spread property value with no environment (literals + the
 * tiny pure operator fragment), as `{known:true,value}` or `{known:false,expr}`.
 * The `expr` on the unknown case lets the fixpoint retry the value against the
 * owner's fold env (interprocedural pass-through, docs §13.1). */
function evalToLiteral(
  node: AnyNode | undefined,
): { known: true; value: Literal } | { known: false; expr?: AnyNode | undefined } {
  const r = evaluate(node, new Map());
  return r.known ? { known: true, value: r.value } : { known: false, expr: node ?? undefined };
}

/** Extract a literal from an attribute value, or `{ known:false }`. */
function literalAttrValue(value: unknown): { known: true; value: Literal } | { known: false } {
  if (value === true) return { known: true, value: true }; // boolean shorthand
  if (value == null) return { known: false };

  const parts = (Array.isArray(value) ? value : [value]) as AnyNode[];
  if (parts.length === 1) {
    const part = parts[0]!;
    if (part.type === 'Text')
      return { known: true, value: (part.data ?? part.raw ?? '') as string };
    if (part.type === 'ExpressionTag' && part.expression?.type === 'Literal') {
      return { known: true, value: part.expression.value as Literal };
    }
    return { known: false };
  }
  // Multiple parts: only fold when every part is static text.
  let text = '';
  for (const part of parts) {
    if (part.type !== 'Text') return { known: false };
    text += (part.data ?? part.raw ?? '') as string;
  }
  return { known: true, value: text };
}

/** Decide what to fold for one component from its global usage. */
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
      plan.constFold.set(decl.name, set.values[0]!);
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

/**
 * Join one declared prop's value over every call site into a {@link
 * PropValueSet} (docs §2.2).  Partial bail (docs §4.1): a prop is `top` as soon
 * as ANY site has a spread but does not pass it *explicitly after that spread*,
 * because the spread may then silently set it.  Sites with no spread that omit
 * the prop contribute its default value.
 */
function valueSetFor(decl: PropDecl, sites: CallSite[], ownerEnv: OwnerEnv): PropValueSet {
  const values: Literal[] = [];
  let dynamic = false;
  let top = false;

  const add = (v: Literal) => {
    if (!values.some((x) => Object.is(x, v))) values.push(v);
  };

  for (const site of sites) {
    const explicit = site.explicit.get(decl.name);
    if (explicit?.afterLastSpread) {
      // Safely explicit: a later attribute, so no spread can override it.
      if (!explicit.dynamic) {
        add(explicit.value);
        continue;
      }
      // Interprocedural pass-through (docs §13.1): a forwarded expression
      // (`prop={ownerProp}`) is resolved against the OWNER's env.  Sound because
      // the owner env describes the owner's runtime (see {@link buildPlans}), so a
      // resolved value/set is one this site provably passes.  `bind:` and
      // multi-part values carry no `expr`, so they never resolve here.
      const env = ownerEnv(site.owner);
      const expr = explicit.expr;
      // A BARE owner-prop reference whose owner narrowed it to a known set
      // contributes that whole set (same `setVar` shape css.ts enumerates for
      // classes; any compound expression must const-fold below).  Sound: the owner
      // keeps the narrowed prop genuinely used (never substituted), so the residual
      // owner passes each set member as-is -> the child receives ⊆ the set.
      // Monotone across rounds: the owner's narrow set only shrinks as its own dead
      // spans grow (see planFixpoint), so this contribution only shrinks -> the
      // fixpoint converges and `plansEqual` (which compares `narrow`) detects it.
      const set = setVar(expr, env.narrow);
      if (set) {
        for (const v of set) add(v);
        continue;
      }
      const r = expr ? evaluate(expr, env.fold) : ({ known: false } as const);
      if (r.known) add(r.value);
      else dynamic = true;
      continue;
    }
    if (site.hadSpread) {
      // Not passed (or passed before the spread) while a spread is present:
      // the spread may set this prop -> Unknown (⊤) for this site.
      top = true;
      continue;
    }
    // No spread and not explicit here -> the prop falls back to its default.
    const def = literalDefault(decl.defaultExpr);
    if (def.known) add(def.value);
    else dynamic = true; // non-literal / unevaluable default -> cannot fold
  }

  return { values, dynamic, top };
}

function literalDefault(
  expr: AnyNode | undefined,
): { known: true; value: Literal } | { known: false } {
  if (!expr) return { known: true, value: undefined }; // omitted default -> undefined
  if (expr.type === 'Literal') return { known: true, value: expr.value as Literal };
  if (expr.type === 'Identifier' && expr.name === 'undefined')
    return { known: true, value: undefined };
  return { known: false };
}

// ---- small AST helpers -------------------------------------------------

interface ImportInfo {
  value: string;
  local: string;
  /** `default` for a default import, the exported name for a named import, or
   * `*` for a namespace import. */
  imported: string;
}

function* importSources(instance: AnyNode): Generator<ImportInfo> {
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
          imported: importedName(spec) ?? local,
        };
    }
  }
}

/** The exported name an `ImportSpecifier` pulls in (`imported`, falling back to
 * `local` for shorthand `import { X }`). */
function importedName(spec: AnyNode): string | undefined {
  const imported = spec.imported;
  if (imported?.type === 'Identifier' && imported.name) return imported.name;
  // Some parsers expose a string-literal `imported` (`import { "x" as y }`).
  if (imported?.type === 'Literal' && typeof imported.value === 'string') return imported.value;
  return undefined;
}

/** The local/exported name strings of an Export/Import specifier. */
function specName(node: AnyNode | undefined): string | undefined {
  if (node?.type === 'Identifier' && node.name) return node.name;
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  return undefined;
}

/** Cap on how many `.js`/`.ts` barrel hops we follow before giving up. */
const MAX_BARREL_HOPS = 8;

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

  // A `.js`/`.ts` barrel: read it and chase the matching re-export.
  let code: string;
  try {
    code = await readFile(targetId);
  } catch {
    return null;
  }
  const body = parseModuleBody(code, targetId);
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
        hops + 1,
      );
      if (via) return via;
    }
  }
  return null;
}

/** Synchronous twin of {@link resolveThroughBarrel} (see {@link
 * buildAnalyzeInputSync}). Keep in lockstep with the async body above. */
function resolveThroughBarrelSync(
  source: string,
  imported: string,
  importer: ComponentId,
  resolve: ResolveSync,
  readFile: ReadFileSync,
  hops = 0,
): ComponentId | null {
  if (hops > MAX_BARREL_HOPS) return null;
  const targetId = resolve(source, importer);
  if (!targetId) return null;

  if (isSvelte(source) || isSvelte(targetId)) {
    return imported === 'default' || imported === '*' ? targetId : null;
  }

  let code: string;
  try {
    code = readFile(targetId);
  } catch {
    return null;
  }
  const body = parseModuleBody(code, targetId);
  if (!body) return null;

  for (const stmt of body) {
    if (stmt.type === 'ExportNamedDeclaration' && stmt.source?.value) {
      for (const spec of stmt.specifiers ?? []) {
        if (specName(spec.exported) !== imported) continue;
        return resolveThroughBarrelSync(
          String(stmt.source.value),
          specName(spec.local) ?? 'default',
          targetId,
          resolve,
          readFile,
          hops + 1,
        );
      }
      continue;
    }
    if (stmt.type === 'ExportNamedDeclaration' && !stmt.source) {
      for (const spec of stmt.specifiers ?? []) {
        if (specName(spec.exported) !== imported) continue;
        const localName = specName(spec.local);
        if (!localName) continue;
        const found = followLocalImport(body, localName);
        if (!found) return null;
        return resolveThroughBarrelSync(
          found.value,
          found.imported,
          targetId,
          resolve,
          readFile,
          hops + 1,
        );
      }
      continue;
    }
    if (stmt.type === 'ExportAllDeclaration' && stmt.source?.value) {
      const via = resolveThroughBarrelSync(
        String(stmt.source.value),
        imported,
        targetId,
        resolve,
        readFile,
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
        return { value, imported: importedName(spec) ?? localName };
    }
  }
  return null;
}

/**
 * Parse a `.js`/`.ts` module's top-level body by reusing the Svelte parser via a
 * `<script module>` wrapper (the engine has no standalone JS parser).  `lang="ts"`
 * is required so TypeScript barrels parse — `export type { … }`, type-only
 * specifiers and annotations are the norm for a design-system's `index.ts`, and a
 * plain JS parse throws on them, leaving the whole library unfollowed.  Returns
 * `null` if it cannot be parsed — callers then leave the barrel unfollowed.
 */
function parseModuleBody(code: string, id: ComponentId): AnyNode[] | null {
  try {
    const ast = parseSvelte(`<script module lang="ts">\n${code}\n</script>`, id);
    return ast.module?.content?.body ?? null;
  } catch {
    return null;
  }
}

/**
 * Derive the child's {@link ReachableInputs} from its `$props()` shape (docs
 * §PR4).  `props`/`hasRestProp` come from {@link findPropsDeclaration}, which
 * matches only a clean top-level ObjectPattern `$props()`; we additionally count
 * ALL `$props()` calls so that a second call, a non-ObjectPattern binding, or a
 * call outside a declarator falls back to ALL (any input might be observed).
 *
 * `$props.id()` (a member call) is NOT a `$props()` call — the props object never
 * leaks through it — so it does not count and does not affect the result.
 */
function computeReachableInputs(
  instance: AnyNode | null | undefined,
  props: PropDecl[] | null,
  hasRestProp: boolean,
  propsPattern: AnyNode | undefined,
  usesSlotInputs: boolean,
): ReachableInputs {
  // A legacy `<slot>` (or a bare `$$slots` read) observes slotted content —
  // inputs that arrive OUTSIDE `$props()` (in Svelte 5 terms, the synthetic
  // `children` input and named-slot / `let:` inputs a call site supplies as body
  // content).  The `$props()` shape cannot model them, so the reverse pass must
  // treat every input as observable, or it would delete the slot-carrying body at
  // each call site.  This holds whether or not an instance script exists.
  if (usesSlotInputs) return { kind: 'all' };
  // No instance script -> no `$props()` -> the component reads no input at all.
  if (!instance) return { kind: 'names', names: new Set() };
  const propsCalls = countPropsCalls(instance);
  if (propsCalls === 0) return { kind: 'names', names: new Set() };
  // A single clean ObjectPattern `$props()` is exactly the case where
  // `findPropsDeclaration` populated `props` (rest-free): its declared external
  // KEY names are what a call site passes, so those are the reachable inputs.
  // Everything else (rest, >1 call, non-ObjectPattern / nested binding) is ALL.
  if (propsCalls !== 1 || hasRestProp || props === null) return { kind: 'all' };
  // Any property whose external name we could NOT statically capture (a
  // string-literal key `{ 'aria-label': label }`, or a computed key `{ [k]: v }`)
  // is a prop the child DOES read but that is absent from `props`, so its call-site
  // attribute would be wrongly droppable.  Fall back to ALL when one is present.
  if (hasUnrepresentableKey(propsPattern)) return { kind: 'all' };
  return { kind: 'names', names: new Set(props.map((p) => p.name)) };
}

/** True when the component observes slotted content outside `$props()`: a legacy
 * `<slot>` element, or a read of the `$$slots` identifier (legal in runes mode,
 * unlike `$$props`/`$$restProps`).  Either signal means {@link
 * computeReachableInputs} cannot model the inputs and must fall back to ALL.
 * `$$slots` can appear in the instance script OR a template expression
 * (`{#if $$slots.default}`), so both trees are scanned; its `$$` prefix cannot be
 * a user binding, so no shadowing check is needed. */
function usesLegacySlotInputs(ast: Root): boolean {
  return (
    nodeSignalsSlotInputs(ast.fragment) || (!!ast.instance && nodeSignalsSlotInputs(ast.instance))
  );
}

function nodeSignalsSlotInputs(root: AnyNode): boolean {
  let found = false;
  walk<null>(root, null, {
    SlotElement(_node, { stop }) {
      found = true;
      stop();
    },
    Identifier(node, { stop }) {
      if (node.name === '$$slots') {
        found = true;
        stop();
      }
    },
  });
  return found;
}

/** True when a `$props()` ObjectPattern binds a prop whose external name is not a
 * plain identifier (a string-literal or computed key), so {@link declared_props}
 * did not capture it. */
function hasUnrepresentableKey(pattern: AnyNode | undefined): boolean {
  for (const p of pattern?.properties ?? []) {
    if (p.type === 'RestElement') continue; // handled via hasRestProp
    if (p.type !== 'Property') return true; // unexpected shape -> conservative ALL
    if (p.computed === true || p.key?.type !== 'Identifier' || !p.key.name) return true;
  }
  return false;
}

/** Count `$props()` calls (callee is the bare `$props` identifier) in the
 * instance script.  More than one means the reachable-input set cannot be pinned
 * to a single destructure, so the reverse pass bails (ALL). */
function countPropsCalls(instance: AnyNode): number {
  let count = 0;
  walk<null>(instance, null, {
    CallExpression(node, { next }) {
      if (node.callee?.type === 'Identifier' && node.callee.name === '$props') count++;
      next();
    },
  });
  return count;
}

function findPropsDeclaration(instance: AnyNode): {
  declaration: AnyNode;
  pattern: AnyNode;
  /** True when `$props()` is not the SOLE declarator of its statement, e.g.
   * `let { x } = $props(), y = 1;` — dropping the now-empty signature removes
   * the whole statement and takes the unrelated `y` binding with it. */
  sharesStatement: boolean;
} | null {
  const program = instance.content;
  for (const stmt of program?.body ?? []) {
    if (stmt.type !== 'VariableDeclaration') continue;
    for (const decl of stmt.declarations ?? []) {
      const init = decl.init;
      const id = decl.id;
      if (
        init?.type === 'CallExpression' &&
        init.callee?.type === 'Identifier' &&
        init.callee.name === '$props' &&
        id?.type === 'ObjectPattern'
      ) {
        return {
          declaration: stmt,
          pattern: id,
          sharesStatement: (stmt.declarations?.length ?? 1) > 1,
        };
      }
    }
  }
  return null;
}
