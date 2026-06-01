// ----------------------------------------------------------------------
// Shared `{#if}`-folding predicate (docs/ARCHITECTURE.md §3, §13).
//
// Both the transform (which *edits* the source) and the analysis fixpoint
// (which needs to know *which call sites disappear*) must agree, to the byte,
// on what folds away — otherwise the fixpoint could exclude a call site the
// transform actually keeps (unsound) or keep one the transform removes (misses
// a cascade).  So the decision for a single if/else-if chain lives here, once,
// and is consumed by both:
//   - transform.ts turns a `ChainDecision` into MagicString edits.
//   - computeDeadSpans() turns the same decisions into the spans of source that
//     genuinely vanish from the output (used to drop call sites in dead code).
// ----------------------------------------------------------------------

import { walk, type AnyNode } from './parse';
import type { Literal } from './ir';
import { evaluateWithSets } from './eval';

export type Span = [number, number];

/** One arm of an `{#if}` / `{:else if}` chain in source order. */
export interface ChainArm {
  block: AnyNode; // the IfBlock for this arm (`{#if}` or `{:else if}`)
  test: AnyNode | undefined;
  consequent: AnyNode | undefined;
}

/**
 * The outcome of folding one chain against the known environments.
 *
 * `removed` are source ranges that do NOT appear in the output (deleted branch
 * markup, dead headers).  `kept` is the single arm consequent that survives
 * verbatim when the chain collapses to it (case (a)/(b1-else)), or `undefined`
 * when the chain keeps its `{#if}` structure.  `recurse` says whether the
 * surviving subtree still contains live `{#if}` blocks that must be folded
 * (true only when the original head arm is kept in place).
 *
 * `headerRewrite`, when present, promotes a surviving `{:else if …}` arm to a
 * fresh `{#if …}` head: `[from, to]` is replaced by `text`.  It carries no call
 * site, so the dead-span view simply treats `[from, to]` as removed.
 */
export interface ChainDecision {
  span: Span; // the whole chain `[head.start, head.end]`
  removed: Span[];
  kept: AnyNode | undefined; // consequent fragment emitted verbatim, if any
  recurse: boolean;
  headerRewrite?: { from: number; to: number; text: string } | undefined;
}

/**
 * Collect the arms of an `{#if}` / `{:else if}` chain in source order, plus the
 * trailing `{:else}` fragment if present.  Each arm carries its own IfBlock node
 * (the head, or an `elseif` continuation).
 */
export function collectChain(top: AnyNode): {
  arms: ChainArm[];
  elseFrag?: AnyNode;
} {
  const arms: ChainArm[] = [];
  let cur: AnyNode | undefined = top;
  let elseFrag: AnyNode | undefined;
  while (cur) {
    arms.push({ block: cur, test: cur.test, consequent: cur.consequent });
    const alt: AnyNode | null | undefined = cur.alternate;
    // `{:else if}` is encoded as an alternate Fragment whose only node is an
    // IfBlock with `elseif === true`; a plain `{:else}` is any other Fragment.
    const elseif: AnyNode | undefined =
      alt?.type === 'Fragment' &&
      alt.nodes?.length === 1 &&
      alt.nodes[0]?.type === 'IfBlock' &&
      alt.nodes[0].elseif === true
        ? alt.nodes[0]
        : undefined;
    if (elseif) {
      cur = elseif;
    } else {
      if (alt?.type === 'Fragment') elseFrag = alt;
      cur = undefined;
    }
  }
  return elseFrag ? { arms, elseFrag } : { arms };
}

/**
 * Decide how one if/else-if chain folds against `env` (constFold) and `setEnv`
 * (value sets).  Soundness: an arm is dropped only when its test is provably
 * FALSE for every reachable value; the chain collapses to a consequent only when
 * an arm is provably TRUE and every earlier arm is provably FALSE.  Otherwise
 * the head is kept and callers recurse for nested blocks.
 *
 * This is the single source of truth used by BOTH the transform and the
 * analysis fixpoint, so they can never disagree on what folds.
 */
export function decideChain(
  top: AnyNode,
  env: Map<string, Literal>,
  setEnv: Map<string, Literal[]>,
): ChainDecision {
  const { arms, elseFrag } = collectChain(top);
  const span: Span = [top.start, top.end];

  // An `{#if}` test fires on truthiness; a known result (const literal OR a
  // proven set-boolean) settles the arm, anything else leaves it live.
  const truth = arms.map((a) => evaluateWithSets(a.test, env, setEnv));
  const isTrue = (t: (typeof truth)[number]) => t.known && Boolean(t.value);
  const isFalse = (t: (typeof truth)[number]) => t.known && !t.value;

  // (a) An arm is provably TRUE and every earlier arm is provably FALSE -> that
  // arm is always taken: collapse the whole chain to its consequent.
  let allEarlierFalse = true;
  for (let i = 0; i < arms.length; i++) {
    const t = truth[i]!;
    if (isTrue(t) && allEarlierFalse) {
      const consequent = arms[i]!.consequent;
      return {
        span,
        kept: consequent,
        removed: aroundKept(span, fragmentSpan(consequent)),
        recurse: false, // re-emitted verbatim; transform does not re-walk it
      };
    }
    if (!isFalse(t)) allEarlierFalse = false;
  }

  // (b) Otherwise keep the arms that are not provably false.
  const firstKept = truth.findIndex((t) => !isFalse(t));

  if (firstKept === -1) {
    // Every arm is provably false: only the `{:else}` (if any) can render.
    if (elseFrag) {
      return {
        span,
        kept: elseFrag,
        removed: aroundKept(span, fragmentSpan(elseFrag)),
        recurse: false,
      };
    }
    return { span, kept: undefined, removed: [span], recurse: false };
  }

  if (firstKept === 0) {
    // Head survives in place: only later provably-false arms are removed, and
    // nested `{#if}` inside the kept arms must still be folded -> recurse.
    return {
      span,
      kept: undefined,
      removed: deadTail(arms, truth, firstKept),
      recurse: true,
    };
  }

  // Head (and maybe more) is provably false: delete the dead prefix and promote
  // the first surviving arm from `{:else if …}` to `{#if …}`.  The promoted arm
  // is re-emitted verbatim, so we do not recurse into it.
  const kept = arms[firstKept]!.block;
  const removed: Span[] = [
    [span[0], kept.start],
    ...deadTail(arms, truth, firstKept),
  ];
  return {
    span,
    kept: undefined,
    removed,
    recurse: false,
    // `{:else if ` -> `{#if ` (header runs from the block start to its test).
    headerRewrite: { from: kept.start, to: kept.test!.start, text: '{#if ' },
  };
}

/** The two ranges of `span` that fall outside the kept inner `[s, e]`. */
function aroundKept(span: Span, inner: Span | null): Span[] {
  if (!inner) return [span]; // empty consequent -> the whole chain is removed
  const out: Span[] = [];
  if (span[0] < inner[0]) out.push([span[0], inner[0]]);
  if (inner[1] < span[1]) out.push([inner[1], span[1]]);
  return out;
}

/** Source span covered by a fragment's nodes, or `null` if it is empty. */
function fragmentSpan(fragment: AnyNode | undefined): Span | null {
  const nodes = fragment?.nodes ?? [];
  if (nodes.length === 0) return null;
  return [nodes[0]!.start, nodes[nodes.length - 1]!.end];
}

/**
 * Removed ranges for provably-false arms AFTER `from` in a chain whose head we
 * keep.  Each dead arm spans from its own block start up to the next arm's block
 * start (or, for the last arm, up to the end of its consequent) — matching the
 * transform's surgical deletion exactly.
 */
function deadTail(
  arms: ChainArm[],
  truth: ReturnType<typeof evaluateWithSets>[],
  from: number,
): Span[] {
  const removed: Span[] = [];
  for (let i = from + 1; i < arms.length; i++) {
    const t = truth[i]!;
    if (!(t.known && !t.value)) continue; // not provably dead -> keep
    const arm = arms[i]!;
    const nextBlock = arms[i + 1]?.block;
    const end = nextBlock
      ? nextBlock.start
      : consequentEnd(arm.consequent, arm.block.end);
    removed.push([arm.block.start, end]);
  }
  return removed;
}

/** End offset of a consequent fragment (its last node), or a fallback. */
export function consequentEnd(
  fragment: AnyNode | undefined,
  fallback: number,
): number {
  const nodes = fragment?.nodes ?? [];
  return nodes.length ? nodes[nodes.length - 1]!.end : fallback;
}

/** Is `node` fully contained in any of the given spans? */
export function inSpans(node: AnyNode, spans: Span[]): boolean {
  return spans.some(([a, b]) => node.start >= a && node.end <= b);
}

/**
 * Compute the source spans that genuinely vanish from a component's output when
 * its plan is applied — i.e. the markup deleted by dead-`{#if}` folding.  This
 * is the SAME predicate the transform uses (both go through {@link decideChain}),
 * so a call site is excluded from a child's prop profile iff the transform would
 * actually delete it (docs §2.1 cascade).
 *
 * We mirror the transform's walk: a chain whose head we keep is recursed into
 * (nested blocks can still fold); a chain we rewrote/collapsed is not, and its
 * span is skipped on later visits via `inSpans`.
 */
export function computeDeadSpans(
  fragment: AnyNode,
  env: Map<string, Literal>,
  setEnv: Map<string, Literal[]>,
): Span[] {
  if (env.size === 0 && setEnv.size === 0) return [];
  const dead: Span[] = [];
  walk<null>(fragment, null, {
    IfBlock(node, { next }) {
      // `elseif` IfBlocks are the continuation of a chain we already own from
      // its head; skip them.  Also skip any block inside a region we removed.
      if (node.elseif || inSpans(node, dead)) return;
      const decision = decideChain(node, env, setEnv);
      for (const r of decision.removed) dead.push(r);
      if (decision.recurse) next();
    },
  });
  return dead;
}
