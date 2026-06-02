import { parseSvelte, walk, type AnyNode, type Root } from './parse';
import {
  emptyPlan,
  type ComponentId,
  type ComponentPlan,
  type Literal,
  type PropValueSet,
} from './ir';
import { computeDeadSpans, inSpans, type Span } from './dead';

export type Resolve = (
  source: string,
  importer: ComponentId,
) => Promise<ComponentId | null> | ComponentId | null;
export type ReadFile = (id: ComponentId) => Promise<string> | string;

/** One declared prop in a `$props()` destructuring. */
export interface PropDecl {
  name: string;
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
  /** local import name (`Sub`) -> resolved child component id. */
  imports: Map<string, ComponentId>;
  /** Declared props, or `null` if the component has no `$props()` pattern. */
  props: PropDecl[] | null;
  /** The `let { ... } = $props()` declaration + its pattern, for editing. */
  propsDeclaration?: AnyNode | undefined;
  propsPattern?: AnyNode | undefined;
  hasRestProp: boolean;
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
   * Resolved ids of CHILD components this file leaks as a value (escape, docs
   * §4.1) — e.g. `<svelte:component this={Child}>`.  `analyze` unions these
   * across the program and bails every escaped component completely, since its
   * prop profile can no longer be observed from `<Child .../>` sites alone.
   */
  escapedComponents: Set<ComponentId>;
  /**
   * Resolved ids of CHILD components this file renders through an import we do
   * NOT treat as a direct `.svelte` default (a named/namespace import, or a
   * `.js`/`.ts` barrel re-exporting a `.svelte` default).  These `<Comp .../>`
   * sites are invisible to {@link collectChildCalls} (whose attribution keys off
   * the default-import `imports` map only), so the child's value set would omit
   * them — folding/narrowing on a partial set is unsound (docs §4.2: every
   * consumer must be enumerated).  `analyze` unions these across the program and
   * bails every such child completely, just like an escape.
   */
  barrelChildIds: Set<ComponentId>;
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
 * has been resolved (`{...obj}` aside).  `dynamic` means the attribute had a
 * non-literal value (`bind:`, dynamic expression): used, value not statically
 * known.  `afterLastSpread` records whether this explicit write happened after
 * the site's last `{...spread}` — only then can a spread not silently override
 * it (docs §4.1, "後勝ち順序で救う").
 */
export interface ExplicitProp {
  value: Literal;
  dynamic: boolean;
  afterLastSpread: boolean;
}

/** How a child component is called at one `<Child .../>` site. */
export interface CallSite {
  /** Did this site have at least one `{...spread}` attribute? */
  hadSpread: boolean;
  /** Last-write-wins explicit props at this site, keyed by prop name. */
  explicit: Map<string, ExplicitProp>;
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

/** Hard cap on fixpoint iterations: convergence is monotone (dead spans only
 * grow as profiles shrink), so this is reached only if something is non-monotone
 * — in which case we stop on the last stable plans rather than loop forever. */
const MAX_FIXPOINT_ITERATIONS = 10;

/** Bail reason stamped on a component leaked as a value (docs §4.1 escape). */
const ESCAPE_REASON = 'escapes as value (e.g. <svelte:component this={X}>)';

/** Bail reason for a child rendered through an unobservable barrel/named import
 * (docs §4.2 — its `<Comp/>` sites cannot be attributed to the value set). */
const BARREL_REASON = 'rendered through a barrel/named import (call sites unobservable)';

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
): Promise<AnalyzeResult> {
  const models = await crawl(entries, resolve, readFile);

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

  // Barrel bail (docs §4.2): a child rendered through a barrel/named import has
  // `<Comp/>` sites we cannot attribute to its value set (they key off the
  // default-import map only).  Folding/narrowing on the visible sites alone is
  // unsound — the hidden site might pass a different value — so we bail every
  // such child completely, exactly like an escape.
  const barreled = new Set<ComponentId>();
  for (const model of models.values()) for (const id of model.barrelChildIds) barreled.add(id);
  for (const id of barreled) {
    const model = models.get(id);
    if (model && !model.bailReasons.includes(BARREL_REASON)) model.bailReasons.push(BARREL_REASON);
  }

  // Round 0: every call site counts (no dead spans yet) — the plain, non-cascade
  // analysis.  Each subsequent round recomputes dead spans from the previous
  // plans and re-derives plans from the call sites that survive, layering the
  // cascade on top, until the plans stop changing.
  let plans = buildPlans(models, buildUsage(models, new Map()));

  for (let i = 0; i < MAX_FIXPOINT_ITERATIONS; i++) {
    const deadSpans = deadSpansForPlans(models, plans);
    const nextPlans = buildPlans(models, buildUsage(models, deadSpans));
    // Convergence is monotone: excluding a folded-away call site can only shrink
    // a child's value set (or clear `dynamic`/`top`), never grow it, so dead
    // spans only grow. Equal plans => a true fixpoint; we then stop.
    if (plansEqual(plans, nextPlans)) {
      plans = nextPlans;
      break;
    }
    plans = nextPlans;
  }

  return { models, plans };
}

/** BFS-crawl the component graph from `entries`, parsing each file once. */
async function crawl(
  entries: ComponentId | ComponentId[],
  resolve: Resolve,
  readFile: ReadFile,
): Promise<Map<ComponentId, FileModel>> {
  const models = new Map<ComponentId, FileModel>();
  const queue: ComponentId[] = Array.isArray(entries) ? [...entries] : [entries];
  const seen = new Set<ComponentId>(queue);

  while (queue.length > 0) {
    const id = queue.shift()!;
    const code = await readFile(id);
    const model = await buildModel(id, code, resolve, readFile);
    models.set(id, model);
    // Crawl both directly-imported children and any child reached through a
    // barrel/named import: the latter must enter `models` so `analyze` can bail
    // it (its prop profile is unobservable from the visible `<Child/>` sites).
    for (const childId of [...model.imports.values(), ...model.barrelChildIds]) {
      if (!seen.has(childId)) {
        seen.add(childId);
        queue.push(childId);
      }
    }
  }
  return models;
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
      usageOf(call.childId).sites.push(readCallSite(call.node));
    }
  }
  return usage;
}

/** Recompute every component's plan from the (cascade-filtered) usage. */
function buildPlans(
  models: Map<ComponentId, FileModel>,
  usage: Map<ComponentId, Usage>,
): Map<ComponentId, ComponentPlan> {
  const plans = new Map<ComponentId, ComponentPlan>();
  for (const model of models.values()) {
    plans.set(model.id, buildPlan(model, usage.get(model.id)));
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
    const spans = computeDeadSpans(model.ast.fragment, plan.constFold, plan.narrow);
    if (spans.length > 0) out.set(model.id, spans);
  }
  return out;
}

async function buildModel(
  id: ComponentId,
  code: string,
  resolve: Resolve,
  readFile: ReadFile,
): Promise<FileModel> {
  const ast = parseSvelte(code, id);
  const imports = new Map<string, ComponentId>();
  /** Local name -> child id reached through a barrel/named import (see
   * {@link FileModel.barrelChildIds}). Disjoint from `imports`. */
  const barrelLocals = new Map<string, ComponentId>();
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

  // Local component imports (`Sub` -> resolved id) AND every imported local
  // name (svelte or not) — the latter is needed for escape detection below.
  const importedLocals = new Set<string>();
  const instance = ast.instance;
  if (instance) {
    for (const imp of importSources(instance)) {
      importedLocals.add(imp.local);
      // A direct `import Sub from './Sub.svelte'`: the common, fully-attributed
      // case — these sites drive the value sets.
      if (imp.imported === 'default' && isSvelte(imp.value)) {
        const childId = await resolve(imp.value, id);
        if (childId) imports.set(imp.local, childId);
        continue;
      }
      // Otherwise this local may STILL render a `.svelte` component we crawl —
      // a named/namespace import, or a default import of a `.js`/`.ts` barrel
      // that re-exports a `.svelte` default.  Resolve through the barrel; if it
      // lands on a `.svelte` file, record it so `analyze` bails that child (its
      // `<Comp/>` sites are invisible to the value-set scan — docs §4.2).
      const childId = await resolveThroughBarrel(imp.value, imp.imported, id, resolve, readFile);
      if (childId) barrelLocals.set(imp.local, childId);
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
        const value = p.value as AnyNode | undefined;
        const defaultExpr = value?.type === 'AssignmentPattern' ? value.right : undefined;
        props.push({ name: key.name, property: p, defaultExpr });
      }
    }
  }

  const childCalls = collectChildCalls(ast, imports);
  // Barrel children actually RENDERED here (`<ChildB .../>` where `ChildB` is a
  // barrel/named import resolving to a `.svelte`). We only taint a child whose
  // sites we genuinely cannot attribute — a barrel import that is never rendered
  // is harmless.
  const barrelChildIds = collectBarrelChildIds(ast, barrelLocals);
  const { shadowedNames, debugNames } = collectTemplateBindings(ast, instance, propsDeclaration);

  // Escape detection (docs §4.1): an imported component referenced as a *value*
  // (most notably `<svelte:component this={X}>`, but also assigned / passed /
  // stored) leaks to a use we cannot follow, so its prop profile is incomplete.
  // We surface that to the OWNING component of the escaped child via
  // `escapedComponents`; `analyze` turns it into a complete bail for that child.
  const escapedComponents = collectEscapedComponents(ast, imports, importedLocals);

  return {
    id,
    code,
    ast,
    imports,
    props,
    propsDeclaration,
    propsPattern,
    hasRestProp,
    childCalls,
    shadowedNames,
    debugNames,
    escapedComponents,
    barrelChildIds,
    bailReasons,
  };
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
): { shadowedNames: Set<string>; debugNames: Set<string> } {
  const shadowedNames = new Set<string>();
  const debugNames = new Set<string>();

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
        next();
      },
    });
  }

  walk<null>(ast.fragment, null, {
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

  return { shadowedNames, debugNames };
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
): Set<ComponentId> {
  const escaped = new Set<ComponentId>();
  const flag = (name: string | undefined) => {
    if (!name) return;
    const childId = imports.get(name);
    if (childId) escaped.add(childId);
  };

  walk<{ parent: AnyNode | null }>(
    ast.fragment,
    { parent: null },
    {
      _(node, { state, next }) {
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
          if (
            node.type === 'Identifier' &&
            node.name &&
            imports.has(node.name) &&
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
 * The set of barrel-resolved children this file actually RENDERS as `<Comp/>`.
 * Only a rendered barrel local taints its child: an unused barrel import passes
 * nothing, so it cannot make a value set incomplete.
 */
function collectBarrelChildIds(
  ast: Root,
  barrelLocals: Map<string, ComponentId>,
): Set<ComponentId> {
  const ids = new Set<ComponentId>();
  if (barrelLocals.size === 0) return ids;
  walk<null>(ast.fragment, null, {
    Component(node, { next }) {
      const childId = node.name ? barrelLocals.get(node.name) : undefined;
      if (childId) ids.add(childId);
      next();
    },
  });
  return ids;
}

/**
 * Read one `<Child .../>` into a {@link CallSite}.  Attributes are in source
 * order, so we resolve last-write-wins (a later `a={…}` overrides an earlier
 * one) and record, per prop, whether its winning write came *after* the last
 * spread — the only case a spread cannot silently override it (docs §4.1).
 */
export function readCallSite(component: AnyNode): CallSite {
  const attrs = component.attributes ?? [];
  let lastSpreadIndex = -1;
  for (let i = 0; i < attrs.length; i++) {
    if (attrs[i]!.type === 'SpreadAttribute') lastSpreadIndex = i;
  }

  const explicit = new Map<string, ExplicitProp>();
  for (let i = 0; i < attrs.length; i++) {
    const attr = attrs[i]!;
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
        : dynamicWrite(i, lastSpreadIndex),
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

  return { hadSpread: lastSpreadIndex >= 0, explicit };
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

function dynamicWrite(index: number, lastSpreadIndex: number): ExplicitProp {
  return {
    value: undefined,
    dynamic: true,
    afterLastSpread: index > lastSpreadIndex,
  };
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
 * invalid Svelte). Both L1 planning ({@link buildPlan}) and L2 specialization
 * (mono.ts) must honor this identically.
 */
export function isFoldBlockedName(model: FileModel, name: string): boolean {
  return model.shadowedNames.has(name) || model.debugNames.has(name);
}

function buildPlan(model: FileModel, u: Usage | undefined): ComponentPlan {
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
    // A name also bound elsewhere is a different entity — folding it corrupts
    // that binding. L2 specialization honors the SAME predicate (see mono.ts).
    if (isFoldBlockedName(model, decl.name)) continue;

    const set = valueSetFor(decl, sites);
    plan.valueSets.set(decl.name, set);

    // `top` (a spread may set it) and `dynamic` (a non-literal write) both
    // poison the set: the reachable values are not fully known, so neither
    // folding nor narrowing is sound.
    if (set.top || set.dynamic) continue;

    // L1: a clean singleton value set is the foldable case.
    if (set.values.length === 1) {
      plan.constFold.set(decl.name, set.values[0]!);
      continue;
    }
    // L1.5: >= 2 distinct literals with no dynamic/⊤ contribution is a fully
    // known reachable value set — branches the prop can never reach are dead
    // (docs §3 L1.5). The prop stays genuinely used, so it is only recorded for
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
function valueSetFor(decl: PropDecl, sites: CallSite[]): PropValueSet {
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
      if (explicit.dynamic) dynamic = true;
      else add(explicit.value);
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
 * `<script module>` wrapper (the engine has no standalone JS parser).  Returns
 * `null` if it cannot be parsed — callers then leave the barrel unfollowed.
 */
function parseModuleBody(code: string, id: ComponentId): AnyNode[] | null {
  try {
    const ast = parseSvelte(`<script module>\n${code}\n</script>`, id);
    return ast.module?.content?.body ?? null;
  } catch {
    return null;
  }
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
