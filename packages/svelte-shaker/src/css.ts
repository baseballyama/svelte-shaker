// ----------------------------------------------------------------------
// CSS rule removal (docs/ARCHITECTURE.md §3 "value-set narrowing", "CSS (shaker 独自の価値)").
//
// The headline differentiator: drop `<style>` rules that target a class the
// component can PROVABLY never produce, given the value sets we computed.
// Svelte's own unused-CSS pruning keeps `.btn-danger` for an interpolated
// `class="btn btn-{variant}"` because it cannot see that `variant ∈
// {primary,secondary}`; rollup cannot either (the class only exists at runtime).
// We can, because we know the reachable value set of `variant`.
//
// SOUNDNESS (the whole contract): a rule is removed ONLY when the component's
// set of possible class names is BOUNDED (every class source enumerable) and the
// rule's every selector references a class that is NOT in that bounded set and
// the rule has no `:global(...)`.  A removed rule therefore targets a class no
// element can ever carry, so it could never have matched any element this
// component renders — removing it cannot change the rendered styling of any
// element that can actually occur.  When anything is uncertain, we KEEP the rule.
// ----------------------------------------------------------------------

import type MagicString from 'magic-string';
import { walk, type AnyNode } from './parse.js';
import type { ComponentPlan, Literal } from './ir.js';
import type { FileModel } from './analyze.js';
import type { Span } from './dead.js';
import { evaluate, setVar } from './eval.js';

/**
 * The set of class names any element this component renders could carry.
 * `unbounded` means at least one element has a class source we cannot enumerate
 * (a non-foldable `class={x}`, or a spread that could carry `class`), so the
 * "possible class set" is really "all class names" and NO rule may be removed.
 */
export interface PossibleClasses {
  classes: Set<string>;
  unbounded: boolean;
}

/** Cap on the cartesian product of interpolated parts; over it -> unbounded. */
const MAX_CLASS_COMBOS = 64;

/**
 * Compute the component's possible class set (docs §3, step 1).  Sources:
 *  - static `class="a b"`  -> the literal tokens,
 *  - `class:foo` directive -> `foo` is always possible (regardless of its cond),
 *  - `class="x-{expr}"` / `class={expr}` where every interpolated `expr` is
 *    foldable (constFold) or narrowable (narrow set) -> enumerate the tokens,
 *  - ANY unbounded source (`class={nonFoldable}`, or a `{...spread}` that could
 *    carry `class`) -> the whole set is unbounded.
 *
 * `dead` (PR8) holds the source spans the transform actually deletes — folded
 * `{#if}` arms and reverse/unread removal regions.  A class-bearing node fully
 * inside one of them never renders, so it contributes NO class and does not make
 * the set unbounded: pruning it is what lets an unbounded source hiding in a dead
 * branch stop blocking every rule.  The spans are the SAME ones the transform
 * emits (no independent recompute), and only genuinely-removed regions are in
 * them — a chain that collapses to a kept arm contributes just its removed parts,
 * so a surviving `{:else}` arm's classes are still counted.
 */
export function computePossibleClasses(
  model: FileModel,
  plan: ComponentPlan,
  dead: readonly Span[] = [],
): PossibleClasses {
  const classes = new Set<string>();
  let unbounded = false;
  const env = plan.constFold;
  const setEnv = plan.narrow;
  const deadStarts = sortedByStart(dead);

  walk<null>(model.ast.fragment, null, {
    _(node, { next }) {
      // Fully inside a deleted region -> never renders.  Skip the whole subtree:
      // every descendant is dead too, so none can carry a class.
      if (containedInDead(node, deadStarts)) return;
      if (!isElementLike(node.type)) {
        next();
        return;
      }
      for (const attr of node.attributes ?? []) {
        // Any spread could carry a `class` -> we can no longer enumerate.
        if (attr.type === 'SpreadAttribute') {
          unbounded = true;
          continue;
        }
        if (attr.type === 'ClassDirective') {
          // `class:foo={cond}` toggles `foo`; `foo` is always a possible class.
          if (attr.name) classes.add(attr.name);
          continue;
        }
        if (attr.type !== 'Attribute' || attr.name !== 'class') continue;
        const result = classTokensFromAttr(attr.value, env, setEnv);
        if (result === UNBOUNDED) unbounded = true;
        else for (const c of result) classes.add(c);
      }
      next();
    },
  });

  return { classes, unbounded };
}

/**
 * The dead spans sorted by start (ascending), for {@link containedInDead}'s binary
 * search.  Copies before sorting so the caller's array is left untouched.
 */
function sortedByStart(dead: readonly Span[]): Span[] {
  return dead.length === 0 ? [] : [...dead].sort((a, b) => a[0] - b[0]);
}

/**
 * Is `node`'s span fully inside any dead span?  `deadStarts` is sorted by start,
 * so the only candidate that can contain `node.start` is the rightmost span whose
 * start is `<= node.start` (binary search) — O(log m) per node, not O(m).  A miss
 * from an unusual nesting only UNDER-prunes (counts a source that was actually
 * dead), which is the sound, conservative direction; it never over-prunes.
 */
function containedInDead(node: AnyNode, deadStarts: Span[]): boolean {
  if (deadStarts.length === 0) return false;
  const start = node.start;
  let lo = 0;
  let hi = deadStarts.length - 1;
  let cand = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (deadStarts[mid]![0] <= start) {
      cand = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return cand >= 0 && deadStarts[cand]![1] >= node.end;
}

/** Sentinel: this class source cannot be enumerated. */
const UNBOUNDED = Symbol('unbounded-class-source');
type TokenResult = Set<string> | typeof UNBOUNDED;

/**
 * Class tokens contributed by one `class=` attribute value, or {@link UNBOUNDED}
 * if any interpolated part is not statically enumerable.  Builds the cartesian
 * product of each part's possible strings, then splits each candidate on
 * whitespace into individual class tokens.
 */
function classTokensFromAttr(
  value: unknown,
  env: Map<string, Literal>,
  setEnv: Map<string, Literal[]>,
): TokenResult {
  // `class` with `value === true` is the `{class}` shorthand (i.e. `class={class}`)
  // — a dynamic binding we cannot enumerate.
  if (value === true) return UNBOUNDED;
  if (value == null) return new Set();

  const parts = (Array.isArray(value) ? value : [value]) as AnyNode[];

  // Each part yields a set of possible string fragments; the attribute's
  // possible full strings are the cartesian product (concatenated in order).
  let combos: string[] = [''];
  for (const part of parts) {
    const frags = partStrings(part, env, setEnv);
    if (frags === UNBOUNDED) return UNBOUNDED;
    const nextCombos: string[] = [];
    for (const base of combos)
      for (const f of frags) {
        nextCombos.push(base + f);
        if (nextCombos.length > MAX_CLASS_COMBOS) return UNBOUNDED;
      }
    combos = nextCombos;
  }

  const tokens = new Set<string>();
  for (const combo of combos) for (const tok of combo.split(/\s+/)) if (tok) tokens.add(tok);
  return tokens;
}

/** The possible string values of one attribute part (Text or ExpressionTag). */
function partStrings(
  part: AnyNode,
  env: Map<string, Literal>,
  setEnv: Map<string, Literal[]>,
): Set<string> | typeof UNBOUNDED {
  if (part.type === 'Text') {
    return new Set([(part.data ?? part.raw ?? '') as string]);
  }
  if (part.type === 'ExpressionTag') {
    return expressionStrings(part.expression, env, setEnv);
  }
  // Unknown part kind (e.g. MustacheTag in older trees): be conservative.
  return UNBOUNDED;
}

/**
 * The possible string values of an interpolated `{expr}` in a class attribute.
 * A bare set-var enumerates its reachable literals; anything else must be a
 * provable constant (constFold / literal).  Non-string literals are stringified
 * the way the DOM would (`String(value)`); anything unprovable is {@link
 * UNBOUNDED}.
 */
function expressionStrings(
  expr: AnyNode | undefined,
  env: Map<string, Literal>,
  setEnv: Map<string, Literal[]>,
): Set<string> | typeof UNBOUNDED {
  if (!expr) return UNBOUNDED;
  // A narrowable prop used directly: enumerate its reachable value set.
  const set = setVar(expr, setEnv);
  if (set) {
    const out = new Set<string>();
    for (const v of set) out.add(stringifyLiteral(v));
    return out;
  }
  // Otherwise it must fold to a single constant (constFold prop or literal expr).
  // We reuse the same sound evaluator the branch folding uses.
  const folded = evaluate(expr, env);
  if (folded.known) return new Set([stringifyLiteral(folded.value)]);
  return UNBOUNDED;
}

/** How a class fragment renders into the DOM `class` attribute string. */
function stringifyLiteral(v: Literal): string {
  // `null`/`undefined`/`false` interpolated into a string become "null"/"undefined"/"false".
  // Svelte concatenates the template, so this matches `String(v)`.
  return String(v);
}

function isElementLike(type: string): boolean {
  // Components can also forward a `class` to a root element, and `<svelte:element>`
  // is dynamic markup — treat all of these as class-bearing for soundness.
  return (
    type === 'RegularElement' ||
    type === 'SvelteElement' ||
    type === 'Component' ||
    type === 'SvelteComponent' ||
    type === 'SvelteSelf'
  );
}

// ----------------------------------------------------------------------
// Rule removal
// ----------------------------------------------------------------------

/**
 * Remove provably-dead top-level `<style>` rules via MagicString span removal
 * (docs §3, step 2/3).  A rule is removed ONLY when the possible class set is
 * bounded, the rule contains no `:global(...)` anywhere, and EVERY selector in
 * the rule's selector list contains at least one class `.C` with `C` absent from
 * the possible set (so no selector in the list can match any element this
 * component can render).  Anything else is KEPT.  Returns the number removed.
 *
 * `dead` (§PR8) are the spans the transform deletes; class sources inside them
 * never render and are excluded from the possible set (see {@link computePossibleClasses}).
 */
export function shakeCss(
  model: FileModel,
  plan: ComponentPlan,
  s: MagicString,
  dead: readonly Span[] = [],
): number {
  const css = model.ast.css;
  if (!css || !css.children) return 0;

  const possible = computePossibleClasses(model, plan, dead);
  // If we cannot bound the class set, every interpolated class might exist:
  // removing nothing is the only sound choice.
  if (possible.unbounded) return 0;

  let removed = 0;
  for (const child of css.children) {
    // Only top-level Rules are considered.  Atrules (`@media`, `@keyframes`, …)
    // are left entirely to Svelte's own pruning: removing a `@media` because one
    // inner rule is dead would be unsound, and keyframes never reference classes.
    if (child.type !== 'Rule') continue;
    if (isRuleDead(child, possible.classes)) {
      removeRule(model.code, child, css.children, s);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Is this whole rule provably dead given the bounded possible class set?
 *
 * A rule is dead iff it contains NO `:global(...)` anywhere AND every selector in
 * its selector list is dead — where a selector (ComplexSelector) is dead iff at
 * least one class `.C` it requires is NOT in the possible set.  Requiring a
 * provably-absent class anywhere in the compound/combinator chain means the whole
 * complex selector can never match (every class in the chain must be present on
 * some element for it to match).  If a complex selector references no class at
 * all (pure element/id/attribute/pseudo), it is NOT dead — we never remove such
 * rules.  An empty selector list is treated as not-dead (keep).
 */
function isRuleDead(rule: AnyNode, possible: Set<string>): boolean {
  if (hasGlobal(rule)) return false;
  const complexes = rule.prelude?.children ?? [];
  if (complexes.length === 0) return false;
  return complexes.every((complex) => isComplexDead(complex, possible));
}

/**
 * A ComplexSelector is dead iff it requires (via a `ClassSelector`) at least one
 * class that the component can never produce.  Every class named in the chain
 * must be present on a matching element, so a single absent required class makes
 * the whole selector unmatchable.
 */
function isComplexDead(complex: AnyNode, possible: Set<string>): boolean {
  let dead = false;
  for (const rel of complex.children ?? []) {
    for (const sel of rel.selectors ?? []) {
      if (sel.type === 'ClassSelector' && sel.name && !possible.has(sel.name)) {
        dead = true;
      }
    }
  }
  return dead;
}

/** Does any selector in this rule use `:global(...)`?  If so we never touch it. */
function hasGlobal(rule: AnyNode): boolean {
  let found = false;
  walk<null>(rule, null, {
    _(node, { next }) {
      if (node.type === 'PseudoClassSelector' && node.name === 'global') found = true;
      next();
    },
  });
  return found;
}

/**
 * Remove a rule's source span, eating the run of whitespace before it so the
 * `<style>` body stays tidy and Svelte still parses what remains.
 */
function removeRule(code: string, rule: AnyNode, siblings: AnyNode[], s: MagicString): void {
  const i = siblings.indexOf(rule);
  const prev = siblings[i - 1];
  // Start just after the previous sibling (or after the leading whitespace at
  // the top of the stylesheet); end at the rule's end.  This removes the rule
  // and the blank line/indentation that preceded it.
  let start = rule.start;
  const floor = prev ? prev.end : 0;
  while (start > floor && /\s/.test(code[start - 1]!)) start -= 1;
  s.remove(start, rule.end);
}
