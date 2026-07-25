/**
 * Per-file model construction (docs ARCHITECTURE §5/§7): parse one component once
 * and extract everything the whole-program pass and the transform reuse — declared
 * props, reachable inputs, child call sites, shadow/write/debug bindings, script
 * constants, and escaped children. Pure source facts, independent of the fixpoint.
 */
import { parseCached, walk, type AnyNode, type ParseCache, type Root } from './parse.js';
import type { ComponentId, InputFile, Literal, ResolvedEdge } from './ir.js';
import { evaluate, unwrapTsAssertions, type EvalResult } from './eval.js';
import { importSources } from './crawl.js';

/**
 * The set of input names a child component can ever OBSERVE at runtime (reverse
 * analysis).  In runes there is no `$$props`/`$$restProps`, so a
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
   * The inputs this component can observe.  Drives the reverse pass:
   * a call site of THIS component may drop an input outside {@link
   * ReachableInputs}.  Computed syntactically from the `$props()` shape.
   */
  reachableInputs: ReachableInputs;
  /**
   * EXTERNAL names of props this component DECLARES but never READS (unread
   * declared props): destructured out of a clean `$props()` yet with zero
   * value-position reference to their local binding anywhere in the instance
   * script or template.  Such a
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

export function buildModelFromInput(
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
 * EXTERNAL names of props DECLARED but never READ.  A declared prop
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
  // `const x = $state(0) as T` wraps the rune in a `TSAsExpression`; erase the
  // (runtime-transparent) assertion first so the `$state`/`$state.raw` unwrap
  // below and `evaluate` both see the real initializer, same as a parser that
  // strips the assertion would.
  init = unwrapTsAssertions(init) ?? undefined;
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
  else if (node.type === 'UpdateExpression') {
    // `x!++` keeps the `!` as a `TSNonNullExpression` around the target (only a
    // bare `x = …` LHS is normalized to the identifier), so read through it or the
    // write goes uncounted and the name is wrongly admitted as a constant.
    const arg = unwrapTsAssertions(node.argument);
    if (arg?.type === 'Identifier' && arg.name) out.add(arg.name);
  }
}

/**
 * Add every identifier bound by a (possibly destructuring) pattern to `out`.
 * Handles bare identifiers, object/array destructuring, defaults and rest.
 */
function addPatternNames(pattern: AnyNode | null | undefined, out: Set<string>): void {
  // A non-null-asserted assignment target keeps its `TSNonNullExpression` wrapper
  // in every position but a bare `x = …` LHS — `x! += 1`, `[x!] = a`, `({k: x!} =
  // o)` — so peel it here (the one choke point every pattern position recurses
  // through) to count the write against the bare name.
  pattern = unwrapTsAssertions(pattern) ?? undefined;
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
 * Derive the child's {@link ReachableInputs} from its `$props()` shape.
 * `props`/`hasRestProp` come from {@link findPropsDeclaration}, which
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
