// ----------------------------------------------------------------------
// Whitespace soundness for `{#if}` folding: when a chain disappears, keep the
// RENDERED whitespace at its seam unchanged.  Svelte trims a whitespace-only
// text node at a fragment edge but keeps one between two rendering nodes, so
// naively deleting a chain (or splicing in an arm) can lose or gain a space.
// ----------------------------------------------------------------------

import type MagicString from 'magic-string';
import { attrValueParts, type AnyNode } from './parse.js';
import { inSpans, type Span } from './dead.js';

/** What {@link removeChain} needs about a chain's position to fix the seam. */
export interface ChainContext {
  /** The Fragment holding the chain, whose `nodes` are its siblings. */
  parent: AnyNode | null;
  /** The chain's index in `parent.nodes`, or -1 when unavailable. */
  index: number;
  /** Whitespace is preserved here (`<pre>`/`<textarea>`/`preserveWhitespace`). */
  preserve: boolean;
  /** The content-model parent element the seam lands in (`null` = text allowed),
   * used to suppress the `{" "}` compensation where text children are invalid. */
  element: string | null;
}

/**
 * Delete a chain that renders nothing, compensating the seam so the RENDERED
 * whitespace is unchanged.  When the chain separated two rendering siblings via
 * a whitespace-only text node, plain deletion would let that node fall to a
 * fragment edge and be trimmed — losing a space.  In that one case we overwrite
 * the whole `L + chain + R` span with `{" "}`: an ExpressionTag is never
 * edge-trimmed, so it renders exactly one space wherever it lands, matching the
 * original.  Otherwise plain deletion already preserves space presence (only the
 * run LENGTH can differ, which the SSR oracle normalizes).  Never compensate
 * under preserved whitespace — there plain deletion is byte-exact — nor inside a
 * text-free parent (`<tr>`, `<tbody>`, …), where Svelte rejects the `{" "}` text
 * child outright and the whitespace rendered nothing to begin with.
 */
export function removeChain(
  removed: Span[],
  span: Span,
  code: string,
  s: MagicString,
  dead: Span[],
  ctx: ChainContext,
): void {
  if (!ctx.preserve && !isTextFreeParent(ctx.element) && ctx.parent?.nodes && ctx.index >= 0) {
    const seam = analyzeSeam(ctx.parent.nodes, ctx.index, span, code, dead);
    if (seam) {
      s.overwrite(seam[0], seam[1], '{" "}');
      dead.push(seam);
      return;
    }
  }
  for (const [a, b] of removed) {
    s.remove(a, b);
    dead.push([a, b]);
  }
}

/**
 * Decide whether removing the chain at `siblings[index]` would lose a separating
 * space, and if so return the `[from, to]` span (covering the adjacent
 * whitespace-only text siblings plus the chain) to overwrite with `{" "}`.
 *
 * Svelte renders a whitespace-only text node as a single space iff it sits
 * between two rendering nodes (element / text / expression tag / block — a
 * comment is transparent and counts as a fragment edge), and trims it at a
 * fragment edge.  With `L`/`R` the chain's adjacent whitespace siblings and
 * `P`/`N` whether a rendering sibling lies just beyond them:
 *   origSpace  = (L && P) || (R && N)          // a space rendered originally
 *   afterSpace = P && N && (L || R)            // … survives plain deletion
 * A space is lost exactly when `origSpace && !afterSpace`.  A sibling already
 * consumed by an earlier compensation is treated as absent so two adjacent dead
 * chains never produce overlapping edits.
 */
function analyzeSeam(
  siblings: AnyNode[],
  index: number,
  span: Span,
  code: string,
  dead: Span[],
): Span | undefined {
  const live = (node: AnyNode | undefined): node is AnyNode => !!node && !inSpans(node, dead);
  const left = siblings[index - 1];
  const right = siblings[index + 1];
  const L = live(left) && isWhitespaceText(left, code) ? left : undefined;
  const R = live(right) && isWhitespaceText(right, code) ? right : undefined;

  const pIdx = L ? index - 2 : index - 1;
  const nIdx = R ? index + 2 : index + 1;
  const P = pIdx >= 0 && isRenderingSibling(siblings[pIdx]!, code);
  const N = nIdx < siblings.length && isRenderingSibling(siblings[nIdx]!, code);

  const origSpace = (!!L && P) || (!!R && N);
  const afterSpace = P && N && (!!L || !!R);
  if (!origSpace || afterSpace) return undefined;
  return [L ? L.start : span[0], R ? R.end : span[1]];
}

/** A text node whose source is entirely whitespace. */
function isWhitespaceText(node: AnyNode, code: string): boolean {
  return node.type === 'Text' && /^\s*$/.test(code.slice(node.start, node.end));
}

/**
 * A sibling that adjacent whitespace can "lean on" so it renders a space.  A
 * whitespace-only text node is not one (it is the seam whitespace itself), and a
 * `Comment` is transparent to SSR — it acts as a fragment edge for trimming, so
 * it is not a rendering neighbour either.
 */
function isRenderingSibling(node: AnyNode, code: string): boolean {
  return node.type !== 'Comment' && !isWhitespaceText(node, code);
}

/** An element inside which Svelte preserves whitespace verbatim. */
export function isPreserveElement(node: AnyNode): boolean {
  return node.type === 'RegularElement' && (node.name === 'pre' || node.name === 'textarea');
}

/**
 * Parent elements whose HTML content model forbids a text child: Svelte's
 * `is_tag_valid_with_parent('#text', …)` rejects a `#text`/`{" "}` here with
 * `node_invalid_placement` — these are exactly its `disallowed_children` entries
 * that carry an `only` list (html/head/frameset/#document can't appear as
 * elements inside a component, so only the table parts remain).  Svelte never
 * renders inter-child whitespace inside them either, so a removed chain's seam
 * needs plain deletion: emitting the `{" "}` compensation would produce a
 * component that fails to compile. See {@link removeChain}.
 */
const TEXT_FREE_PARENTS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'colgroup']);

/**
 * Node types that reset the content-model parent to "unknown" (text allowed
 * again), mirroring svelte's `parent_element: null` reset in the SvelteElement /
 * SvelteFragment / SnippetBlock / Component visitors.  A `{" "}` seam in any of
 * these contexts is valid, so the seam compensation may proceed.
 */
const PARENT_ELEMENT_RESET = new Set([
  'SvelteElement',
  'SvelteFragment',
  'SnippetBlock',
  'Component',
  'SvelteSelf',
  'SvelteComponent',
]);

/**
 * The content-model parent element a seam would land in for `node`'s children,
 * given the element the walk is currently inside.  Mirrors svelte's
 * `parent_element` threading: a `RegularElement` becomes the parent, the reset
 * node types clear it, and every other node (Fragment, blocks, …) is transparent
 * and inherits.  `null` means "text allowed" (root or a reset context).
 */
export function childParentElement(node: AnyNode, current: string | null): string | null {
  if (node.type === 'RegularElement') return node.name ?? null;
  if (PARENT_ELEMENT_RESET.has(node.type)) return null;
  return current;
}

/** True when an `{" "}` seam would be an invalid text child of `element`. */
function isTextFreeParent(element: string | null): boolean {
  return element !== null && TEXT_FREE_PARENTS.has(element);
}

/** Does the component opt into preserved whitespace via `<svelte:options>`? */
export function hasPreserveWhitespaceOption(fragment: AnyNode): boolean {
  let preserve = false;
  // `<svelte:options>` is only legal at the top level of the component, so scan the
  // fragment's direct children rather than walking the whole tree.
  for (const node of fragment.nodes ?? []) {
    if (node.type !== 'SvelteOptions') continue;
    for (const a of node.attributes ?? []) {
      if (a.type !== 'Attribute' || a.name !== 'preserveWhitespace') continue;
      // `preserveWhitespace` (boolean shorthand) or `={true}` opts in; only an
      // explicit `={false}` opts out.  Any other (invalid) form is treated as
      // opting in, since svelte:options requires a static value.
      preserve = !isExplicitFalse(a.value);
    }
  }
  return preserve;
}

/** True when an attribute value is the literal `{false}` (or `false`). */
function isExplicitFalse(value: unknown): boolean {
  if (value === false) return true;
  return attrValueParts(value).some(
    (p) =>
      p?.type === 'ExpressionTag' &&
      p.expression?.type === 'Literal' &&
      p.expression.value === false,
  );
}
