/**
 * Call-site reading and the per-prop value-set join (docs ARCHITECTURE §2.2/§4.1):
 * turn one `<Child .../>` into a {@link CallSite} (last-write-wins, spread
 * classification, synthesized body props) and join a declared prop's value over
 * every site into a {@link PropValueSet}, resolving forwarded expressions against
 * the owner's fold env (interprocedural pass-through, docs §13.1).
 */
import { attrValueParts, type AnyNode } from './parse.js';
import type { ComponentId, Literal, PropValueSet } from './ir.js';
import { evaluate, literalValue, setVar, unwrapTsAssertions } from './eval.js';
import type { PropDecl } from './model.js';

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

/**
 * The OWNER component's forwardable knowledge, both remapped to the LOCAL binding
 * names a forwarded expression references: `fold` collapses a prop to a single
 * literal (`constFold`), `narrow` holds a prop's known reachable value set
 * (`narrow`, >= 2 literals).  A bare owner-prop reference forwarded verbatim
 * (`<Child v={ownerProp}/>`) can propagate EITHER — the single value or the whole
 * set (docs §13.1).  `constFold` and `narrow` never share a name (buildPlan is
 * exclusive: singleton -> constFold, >= 2 -> narrow), so lookup order is immaterial.
 */
export interface OwnerFoldEnv {
  fold: ReadonlyMap<string, Literal>;
  narrow: ReadonlyMap<string, Literal[]>;
}
/** {@link OwnerFoldEnv} for a given owner id (empty for `undefined` / a bailed owner). */
export type OwnerEnv = (owner: ComponentId | undefined) => OwnerFoldEnv;

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
  const parts = attrValueParts(value);
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

  const parts = attrValueParts(value);
  if (parts.length === 1) {
    const part = parts[0]!;
    if (part.type === 'Text')
      return { known: true, value: (part.data ?? part.raw ?? '') as string };
    if (part.type === 'ExpressionTag') {
      // Recognize `prop={'x' as const}` as the literal it wraps, so the write is
      // classified NON-dynamic identically to a parser that strips the assertion.
      // Both paths already fold the value (via the expr fallback), but the
      // `dynamic` flag itself must match — mono's `specializableShape` reads it.
      const expr = unwrapTsAssertions(part.expression);
      if (expr?.type === 'Literal') return literalValue(expr);
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

/**
 * Join one declared prop's value over every call site into a {@link
 * PropValueSet} (docs §2.2).  Partial bail (docs §4.1): a prop is `top` as soon
 * as ANY site has a spread but does not pass it *explicitly after that spread*,
 * because the spread may then silently set it.  Sites with no spread that omit
 * the prop contribute its default value.
 */
export function valueSetFor(decl: PropDecl, sites: CallSite[], ownerEnv: OwnerEnv): PropValueSet {
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
  // A default like `= 500 as const` reaches here as a `TSAsExpression`; the
  // assertion erases at runtime, so read through it to the bare default value.
  expr = unwrapTsAssertions(expr) ?? undefined;
  if (!expr) return { known: true, value: undefined }; // omitted default -> undefined
  // `literalValue` is the same gate `literalAttrValue` and `evaluate` use: a
  // BigInt/RegExp default (no faithful source form) or a `null` that is really
  // `1e999` surviving JSON transport must stay UNKNOWN here too, or a call site
  // that merely omits the prop reintroduces the crash/misfold this default path
  // exists to prevent.
  if (expr.type === 'Literal') return literalValue(expr);
  if (expr.type === 'Identifier' && expr.name === 'undefined')
    return { known: true, value: undefined };
  return { known: false };
}
