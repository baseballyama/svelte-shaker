// ----------------------------------------------------------------------
// Folded-prop substitution: replace every surviving reference to a folded prop
// with its proven literal, handling the shorthand syntactic positions (`{name}`,
// `class:name`, `style:name`, object shorthand) that a bare identifier overwrite
// would corrupt.  Shared by the live substitution pass and the verbatim re-emit
// of a kept `{#if}`/ternary arm.
// ----------------------------------------------------------------------

import { walk, isSpace, type AnyNode } from './parse.js';
import type { Literal } from './ir.js';
import type { FileModel } from './model.js';
import { inSpans, type Span } from './dead.js';

/**
 * One folded-prop edit: overwrite source `[start, end)` with
 * `head + <literal> + tail`.  For a plain expression read `head`/`tail` are empty
 * and `[start, end)` is the identifier itself; for a SHORTHAND position they wrap
 * the literal back into the explicit `name={…}` form (see {@link foldRefFor}).
 */
export interface FoldRef {
  start: number;
  end: number;
  head: string;
  tail: string;
  /** The identifier is the OBJECT of a non-computed member access (`NAME.foo`).
   * A number folded here must be parenthesized ({@link foldReplacement}). */
  memberObject?: boolean;
}

/**
 * The replacement text for a folded reference: `head + <literal> + tail`, but a
 * NUMBER used as the object of a member access is parenthesized.  `count.toFixed()`
 * with `count` = 5000 would otherwise emit `5000.toFixed()`, where the parser reads
 * `5000.` as a float literal and then hits `toFixed` — "Identifier directly after
 * number".  `(5000)` disambiguates.
 *
 * Strictly, only a decimal INTEGER literal is ambiguous here: `5.5.toFixed()` and
 * `5e3.toFixed()` already parse (the number token ends before the `.`), and a
 * `Literal` never carries a BigInt.  We wrap EVERY number uniformly anyway — the
 * parens are always valid and the rule is simpler than sniffing the numeric form.
 * Non-number literals (string / boolean / `null`) are never wrapped: they need no
 * disambiguation, so existing golden output is unchanged.
 */
export function foldReplacement(ref: FoldRef, value: Literal): string {
  const lit = literalSource(value);
  const body = ref.memberObject === true && typeof value === 'number' ? `(${lit})` : lit;
  return ref.head + body + ref.tail;
}

/** Find every folded-prop reference in `model`, outside dead spans, by name. */
export function collectPropRefs(
  model: FileModel,
  env: Map<string, Literal>,
  dead: Span[],
): Map<string, FoldRef[]> {
  const refs = new Map<string, FoldRef[]>();

  const scan = (root: AnyNode | null | undefined) => {
    if (!root) return;
    collectFoldRefs(root, env, model.code, (name, ref, node) => {
      if (inSpans(node, dead) || node === model.propsPattern) return;
      (refs.get(name) ?? setDefault(refs, name)).push(ref);
    });
  };

  scan(model.ast.instance); // only the instance script can reference props
  scan(model.ast.fragment);
  return refs;
}

/**
 * Walk `root` and `emit` an edit for every folded-prop reference — both plain
 * expression reads AND the shorthand positions {@link foldRefFor} expands, plus
 * `style:NAME` shorthands (which have no expression node and so are invisible to
 * an identifier walk).  `emit` receives the originating node so callers can
 * filter by position (e.g. skip dead spans).  Shared by the live substitution
 * pass and the verbatim re-emit ({@link substitutedSlice}) so both fold
 * shorthands identically.
 */
export function collectFoldRefs(
  root: AnyNode,
  env: Map<string, Literal>,
  code: string,
  emit: (name: string, ref: FoldRef, node: AnyNode) => void,
): void {
  walk<{ parent: AnyNode | null; grandparent: AnyNode | null }>(
    root,
    { parent: null, grandparent: null },
    {
      _(node, { state, next }) {
        // `style:NAME` shorthand carries no expression node (its `value` is the
        // boolean `true` marker), so an identifier walk never sees it; expand it
        // to `style:NAME={lit}` or the dropped prop would dangle.  Trim trailing
        // whitespace from the span: some parsers (rsvelte) fold the gap before the
        // next attribute into the directive's `end`, and overwriting that gap
        // would glue the expansion onto the next attribute.
        if (
          node.type === 'StyleDirective' &&
          node.value === true &&
          node.name &&
          env.has(node.name)
        ) {
          let end = node.end;
          while (end > node.start && isSpace(code[end - 1]!)) end -= 1;
          const src = code.slice(node.start, end); // `style:NAME`
          emit(node.name, { start: node.start, end, head: `${src}={`, tail: '}' }, node);
        } else if (
          node.type === 'Identifier' &&
          node.name &&
          env.has(node.name) &&
          !isNonReference(node, state.parent)
        ) {
          emit(node.name, foldRefFor(node, state.parent, state.grandparent, code), node);
        }
        next({ parent: node, grandparent: state.parent });
      },
    },
  );
}

/**
 * The edit to substitute a folded prop at the given identifier.  A plain
 * expression read overwrites just the identifier (no wrapping).  A SHORTHAND
 * syntactic position is expanded to the explicit `name={value}` the long form
 * uses, because overwriting the bare identifier there corrupts the syntax:
 *
 *   class:compact   ->  class:compact={false}   (`class:false` is a *different* class)
 *   {compact}       ->  compact={false}         (`{false}` is a reserved word)
 *
 * The full forms (`class:compact={compact}`, `compact={compact}`) already place
 * the identifier inside an expression slot, so they fall through to the plain
 * overwrite and are unaffected.
 */
function foldRefFor(
  node: AnyNode,
  parent: AnyNode | null,
  grandparent: AnyNode | null,
  code: string,
): FoldRef {
  // `class:NAME` shorthand: the identifier sits in the directive-name slot, right
  // after the `:` (the long form puts it inside `={…}`, where the char is `{`).
  if (
    parent?.type === 'ClassDirective' &&
    parent.expression === node &&
    code[node.start - 1] === ':'
  ) {
    const name = code.slice(node.start, node.end);
    return { start: node.start, end: node.end, head: `${name}={`, tail: '}' };
  }
  // `{NAME}` attribute shorthand: the braces belong to the Attribute, not the
  // ExpressionTag, so overwrite the whole attribute (`{NAME}` -> `NAME={lit}`).
  if (
    parent?.type === 'ExpressionTag' &&
    grandparent?.type === 'Attribute' &&
    grandparent.name &&
    code[grandparent.start] === '{'
  ) {
    return {
      start: grandparent.start,
      end: grandparent.end,
      head: `${grandparent.name}={`,
      tail: '}',
    };
  }
  // Object shorthand `{ NAME }`: a `Property` with `shorthand: true` whose single
  // identifier is BOTH key and value.  A plain replace yields `{ "lit" }` (invalid);
  // expand to `NAME: lit`.
  if (parent?.type === 'Property' && parent.shorthand === true && parent.value === node) {
    const name = code.slice(node.start, node.end);
    return { start: node.start, end: node.end, head: `${name}: `, tail: '' };
  }
  // Plain expression read.  Flag a member-access object (`NAME.foo`) so a folded
  // number is parenthesized ({@link foldReplacement}); a computed access
  // (`NAME[i]`) needs no wrapping (`5000[i]` parses), so it stays unflagged.
  const memberObject =
    parent?.type === 'MemberExpression' && parent.object === node && parent.computed !== true;
  return { start: node.start, end: node.end, head: '', tail: '', memberObject };
}

/** True when an Identifier is a property key / member name, not a value read. */
function isNonReference(node: AnyNode, parent: AnyNode | null): boolean {
  if (!parent) return false;
  if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed)
    return true;
  if (
    parent.type === 'Property' &&
    parent.key === node &&
    !parent.computed &&
    parent.shorthand !== true
  )
    return true;
  // TS type-member name (`interface Props { NAME?: T }` / a `{ NAME: T }` type
  // literal / a method signature). The key is a member NAME in a type position,
  // never a value read of a prop, so folding a same-named prop's literal into it
  // would corrupt the type (`width?: number` -> `36?: number`). Type text is erased
  // at compile, so the old behavior was byte-wrong but not a runtime fault — still,
  // the type member must keep its name. (`computed` keys `[expr]` ARE value reads.)
  if (
    (parent.type === 'TSPropertySignature' || parent.type === 'TSMethodSignature') &&
    parent.key === node &&
    !parent.computed
  )
    return true;
  // Import / export specifier slots are MODULE-EXPORT names, never a read of a
  // local prop value (`import { count as store }` -> `count` is the module's
  // export, not our prop).  Substituting a literal there is invalid syntax, so
  // exclude every specifier identifier position defensively.
  if (
    parent.type === 'ImportSpecifier' ||
    parent.type === 'ImportDefaultSpecifier' ||
    parent.type === 'ImportNamespaceSpecifier' ||
    parent.type === 'ExportSpecifier'
  )
    return true;
  // Declaration sites are excluded via the shadowing guard in analyze.ts, so
  // anything reaching here in an expression slot is a genuine value read.
  return false;
}

export function fragmentSource(
  fragment: AnyNode | undefined,
  env: Map<string, Literal>,
  code: string,
): string {
  const nodes = fragment?.nodes ?? [];
  if (nodes.length === 0) return '';
  return substitutedSlice(nodes[0]!.start, nodes[nodes.length - 1]!.end, nodes, env, code);
}

/**
 * The source for `[from, to)` with every folded-prop (constFold) reference
 * inside `roots` replaced by its literal.  Used when re-emitting a kept `{#if}`
 * arm or ternary arm verbatim: the whole span is overwritten in one shot, so the
 * normal substitution pass cannot reach references inside it, yet those props
 * are about to leave the `$props()` signature.  Substituting here keeps the
 * emitted text self-contained (no dangling identifier) and observably identical
 * — every reference is replaced by the exact constant it was proven to equal.
 */
export function substitutedSlice(
  from: number,
  to: number,
  roots: AnyNode[],
  env: Map<string, Literal>,
  code: string,
): string {
  if (env.size === 0) return code.slice(from, to);

  // Collect every folded-prop edit in source order (shorthand-aware, see
  // {@link collectFoldRefs}); each is an `[start,end)` overwrite with wrapping.
  const refs: Array<FoldRef & { name: string }> = [];
  for (const root of roots) {
    collectFoldRefs(root, env, code, (name, ref) => refs.push({ ...ref, name }));
  }
  if (refs.length === 0) return code.slice(from, to);

  refs.sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = from;
  for (const ref of refs) {
    out += code.slice(cursor, ref.start);
    out += foldReplacement(ref, env.get(ref.name)!);
    cursor = ref.end;
  }
  out += code.slice(cursor, to);
  return out;
}

function setDefault<K, V>(map: Map<K, V[]>, key: K): V[] {
  const arr: V[] = [];
  map.set(key, arr);
  return arr;
}

/** Source text for a folded value, faithful for every member of {@link Literal}
 * (the union {@link evaluate} admits).  Always an expression, so it drops into
 * both substitution positions unchanged. */
function literalSource(value: Literal): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'number') return numberSource(value);
  return JSON.stringify(value);
}

/**
 * `JSON.stringify` flattens `Infinity`/`-Infinity`/`NaN` to `null`, so those get
 * an explicit form.  Written as arithmetic rather than the `Infinity`/`NaN`
 * globals because the substituted text lands in the CALLEE's scope, where a
 * local of either name would silently capture it; `(0/0)` cannot be shadowed.
 * (`-0`, the fourth lossy case, never reaches here — see `isFoldableValue`.)
 */
function numberSource(value: number): string {
  if (Number.isNaN(value)) return '(0/0)';
  if (value === Infinity) return '(1/0)';
  if (value === -Infinity) return '(-1/0)';
  return JSON.stringify(value);
}
