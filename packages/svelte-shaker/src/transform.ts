// ----------------------------------------------------------------------
// Transform orchestration: drive the per-file shake phases and slim one
// component body.  The whitespace-seam, folded-prop substitution, `$props()`
// slimming, and monomorphization-rewrite mechanics live in their own modules
// (whitespace.ts / substitute.ts / drop-props.ts / mono-rewrite.ts).
// ----------------------------------------------------------------------

import MagicString from 'magic-string';
import { walk, attrSpanWithSpace, attrValueParts, type AnyNode } from './parse.js';
import type { ComponentId, ComponentPlan, Literal } from './ir.js';
import { remapToLocalNames } from './analyze.js';
import type { FileModel } from './model.js';
import { decideChain, inSpans, type Span } from './dead.js';
import { collectReverseRemovals, applyReverseRemovals, type ReverseOp } from './reverse.js';
import { collectUnread } from './unread.js';
import { evaluate } from './eval.js';
import { shakeCss } from './css.js';
import {
  removeChain,
  isPreserveElement,
  childParentElement,
  hasPreserveWhitespaceOption,
  type ChainContext,
} from './whitespace.js';
import {
  collectPropRefs,
  foldReplacement,
  fragmentSource,
  substitutedSlice,
} from './substitute.js';
import { dropProps } from './drop-props.js';

/**
 * Apply every plan to every component and return the shaken source per file.
 *
 * Two phases over a shared set of MagicStrings so that a parent's call-site
 * attributes are removed using each child's *actually dropped* props (not just
 * what the plan proposed): a prop only leaves the public signature when every
 * reference to it could be folded or substituted away.
 */
export function transformAll(
  models: Map<ComponentId, FileModel>,
  plans: Map<ComponentId, ComponentPlan>,
): Record<ComponentId, string> {
  return emit(models, runBasePhases(models, plans));
}

/** Shared empty local fold env for a bailed owner (nothing forwards a constant). */
const EMPTY_LOCAL_ENV: ReadonlyMap<string, Literal> = new Map();

/**
 * Merge an owner's static script constants with its remapped folded props for the
 * phase-2 side-effect check.  Both are keyed by LOCAL name and are disjoint (a
 * `$props()` local and a top-level script const cannot share a name — JS
 * redeclaration), so the merge is order-independent; either operand is returned
 * as-is when the other is empty (the common case).  Mirrors analyze.ts's
 * `mergeScriptConsts` (kept separate so neither module imports the other).
 */
function mergeLocalConstEnv(
  scriptConsts: ReadonlyMap<string, Literal>,
  foldedProps: ReadonlyMap<string, Literal>,
): ReadonlyMap<string, Literal> {
  if (scriptConsts.size === 0) return foldedProps;
  if (foldedProps.size === 0) return scriptConsts;
  return new Map([...scriptConsts, ...foldedProps]);
}

/**
 * Phases 1–2, shared by {@link transformAll} and `transformAllWithMono`:
 * fold each component body and drop its folded props (phase 1), then strip the
 * now-pointless attribute at every call site of a dropped prop (phase 2).
 * Returns the per-file MagicStrings, ready for the optional monomorphization phase 3.
 */
export function runBasePhases(
  models: Map<ComponentId, FileModel>,
  plans: Map<ComponentId, ComponentPlan>,
): Map<ComponentId, MagicString> {
  const strings = new Map<ComponentId, MagicString>();
  const dropped = new Map<ComponentId, Set<string>>();
  /** Regions phase 1 edited per component — phase 2 must not edit inside them. */
  const editedSpans = new Map<ComponentId, Span[]>();

  // Phase 0 — reverse analysis: per owner, the call-site attributes /
  // `{#snippet}` blocks / body content supplying an input the child can never
  // read.  Computed BEFORE phase 1 so its regions can be handed to phase 1 as
  // protected — phase 1 makes no fold/substitution edit inside a span phase 2.5
  // then deletes whole, which keeps the two phases from touching the same range.
  const reverse = new Map<ComponentId, ReverseOp[]>();
  for (const model of models.values()) {
    const plan = plans.get(model.id)!;
    if (plan.bail) continue; // a bailed owner is left completely untouched
    const ops = collectReverseRemovals(model, models, plans);
    if (ops.length > 0) reverse.set(model.id, ops);
  }

  // Phase 0b — unread declared props: the call-site attributes (a)
  // and declaration drops (b) for props a child DECLARES but never reads.  Its
  // attribute removals share the reverse pass's protect/apply machinery (they
  // never target the same attribute — declared vs undeclared), so merge them per
  // owner; the declaration drops fold into phase 1's `dropProps` via `extraDrops`.
  const unread = collectUnread(models, plans);
  const removals = mergeReverseOps(reverse, unread.removals);

  // Phase 1 — component bodies: fold dead branches, drop folded (and unread) props.
  for (const model of models.values()) {
    const s = new MagicString(model.code);
    strings.set(model.id, s);
    const plan = plans.get(model.id)!;
    if (plan.bail) {
      dropped.set(model.id, new Set());
      continue;
    }
    const result = transformBody(
      model,
      plan,
      s,
      removals.get(model.id)?.map((op) => op.protect),
      unread.drops.get(model.id),
    );
    dropped.set(model.id, result.dropped);
    editedSpans.set(model.id, result.dead);
  }
  // Phase 2 — call sites: remove attributes for props the child actually dropped,
  // skipping any call site phase 1 folded away (its attributes went with it).
  for (const model of models.values()) {
    const plan = plans.get(model.id)!;
    // A forwarded expression (`<Child prop={ownerProp}/>`) that the owner proves
    // constant — a folded prop OR an owner-local script constant (docs §13.1) — is
    // side-effect-free, so once the child drops the prop its attribute is as
    // removable as a written literal.  Give phase 2 the owner's fold env plus its
    // `scriptConstEnv`, both local-keyed as the expression references props/locals.
    const foldEnv = plan.bail ? EMPTY_LOCAL_ENV : remapToLocalNames(plan.constFold, model);
    const ownerEnv = mergeLocalConstEnv(model.scriptConstEnv, foldEnv);
    removeCallSiteAttributes(
      model,
      dropped,
      strings.get(model.id)!,
      editedSpans.get(model.id) ?? [],
      ownerEnv,
    );
  }
  // Phase 2.5 — reverse + unread declared: delete the
  // inputs the child can never read / never declares.  Runs after phase 1/2 and
  // skips any call site folded away in phase 1.  These removals never target the
  // same attribute phase 2 does: phase 2 removes attributes for props the child
  // FOLDED away, while these remove props it never declares or never reads (both
  // disjoint from the const-fold set).
  for (const [id, ops] of removals) {
    applyReverseRemovals(ops, strings.get(id)!, editedSpans.get(id) ?? []);
  }
  return strings;
}

/**
 * Merge the reverse and unread-declared removals per owner into one
 * list, so they share the protect / apply passes.  The two never target the same
 * attribute (one names an UNDECLARED prop, the other a DECLARED-but-unread one),
 * and {@link applyReverseRemovals} already sorts + de-nests the merged list.
 */
function mergeReverseOps(
  reverse: Map<ComponentId, ReverseOp[]>,
  unread: Map<ComponentId, ReverseOp[]>,
): Map<ComponentId, ReverseOp[]> {
  if (unread.size === 0) return reverse;
  const merged = new Map<ComponentId, ReverseOp[]>();
  for (const [id, ops] of reverse) merged.set(id, [...ops]);
  for (const [id, ops] of unread) {
    const existing = merged.get(id);
    if (existing) existing.push(...ops);
    else merged.set(id, [...ops]);
  }
  return merged;
}

/** Stringify every model's MagicString into the output record. */
export function emit(
  models: Map<ComponentId, FileModel>,
  strings: Map<ComponentId, MagicString>,
): Record<ComponentId, string> {
  const out: Record<ComponentId, string> = {};
  for (const model of models.values()) out[model.id] = strings.get(model.id)!.toString();
  return out;
}

function transformBody(
  model: FileModel,
  plan: ComponentPlan,
  s: MagicString,
  /** Reverse/unread-removal regions the body pass must not edit inside. */
  seedDead?: Span[],
  /** EXTERNAL prop names to also drop from the `$props()` signature (unread declared props). */
  extraDrops?: Set<string>,
): { dropped: Set<string>; dead: Span[] } {
  const dead: Span[] = [];
  const dropped = shakeBody(
    model,
    plan.constFold,
    plan.narrow,
    plan,
    s,
    dead,
    seedDead,
    extraDrops,
  );
  return { dropped, dead };
}

/**
 * Slim one component's body against the given fold (`env`) and narrow (`setEnv`)
 * environments, editing `s` in place, and return the set of props that left the
 * `$props()` signature.  Factored out of {@link transformBody} so monomorphization
 * (see `mono.ts`) can re-run the SAME pipeline with an augmented
 * `env` (a call site's extra literal props) on a fresh MagicString — guaranteeing
 * a specialized residual is produced by exactly the audited unused-prop fold / constant fold / value-set narrowing machinery,
 * never a parallel code path.  `cssPlan` carries the value sets CSS removal reads
 * (its `constFold`/`narrow` are overridden by `env`/`setEnv` before use).
 */
export function shakeBody(
  model: FileModel,
  env: Map<string, Literal>,
  setEnv: Map<string, Literal[]>,
  cssPlan: ComponentPlan,
  s: MagicString,
  /**
   * If provided, receives every region this body EDITED (dead `{#if}`/ternary arms
   * removed, and collapse spans overwritten whole).  Phase 2 (call-site attribute
   * removal) needs these so it never edits inside a region we already changed — a
   * `<Child dropped={…}/>` sitting in a folded-away branch would otherwise produce
   * an overlapping MagicString edit ("Cannot split a chunk that has already been
   * edited").  Monomorphization does not pass it; it edits fresh strings.
   */
  outDead?: Span[],
  /**
   * Reverse-removal regions to treat as already-dead: the fold and
   * substitution passes below skip anything inside them, so no edit lands in a
   * span the reverse phase then deletes whole (which would overlap in
   * MagicString).  Only the base transform passes it; mono edits fresh strings.
   */
  seedDead?: Span[],
  /**
   * EXTERNAL prop names to also drop from the `$props()` signature — the unread
   * declared props.  Folded into the SAME {@link dropProps} call as
   * the const-fold drops so consecutive dropped properties tile cleanly, but NOT
   * returned: unlike a folded prop, an unread prop's call-site attributes are
   * removed by the reverse/unread phase (spread-aware), not phase 2.
   */
  extraDrops?: Set<string>,
): Set<string> {
  // Nothing to fold (constant fold) and nothing to narrow (value-set narrowing):
  // no branch/prop edits, so the fold-driven passes (branch/ternary folding,
  // reference substitution, folded-prop drops) have no purchase and we skip them.
  // But CSS removal does NOT depend on the fold env: when the reverse/unread pass
  // still deletes a region (`seedDead`), an unbounded class source hiding in it
  // (`class={dynamic}`, `{...rest}`) vanishes with the region (docs §3), so the
  // component can become bounded and a now-unreachable rule removable.  Run
  // {@link shakeCss} with `seedDead` as the pruned set and EMPTY envs — sound
  // because the removal condition (a bounded possible-class set + rules whose class
  // is outside it + no `:global`) never reads the fold env; an empty env only makes
  // more interpolations unbounded, i.e. strictly more conservative.
  if (env.size === 0 && setEnv.size === 0) {
    // …but an unread-prop drop still edits the signature, even with
    // nothing to fold.  Apply it and return no folded props (phase 2 does nothing).
    if (extraDrops && extraDrops.size > 0) dropProps(model, extraDrops, s);
    // With no reverse/unread region there is nothing to prune, so keep the original
    // early return: the component is left byte-identical (behaviour + perf unchanged).
    if (seedDead && seedDead.length > 0) {
      const cssView: ComponentPlan = { ...cssPlan, constFold: new Map(), narrow: new Map() };
      shakeCss(model, cssView, s, seedDead);
    }
    return new Set();
  }
  const code = model.code;

  // `env`/`setEnv` arrive keyed by the EXTERNAL prop name (that is what the plan
  // and the monomorphization call-site shapes carry).  Every body/template reference, however,
  // uses the prop's LOCAL binding name (`prop: alias` -> `alias`), and the two can
  // even be different entities (a same-named import).  Remap ONCE to local-keyed
  // maps for every name-matched pass below (branch folding, ternaries, reference
  // substitution, CSS); the `$props()` signature drop keeps the external names.
  const localEnv = remapToLocalNames(env, model);
  const localSetEnv = remapToLocalNames(setEnv, model);

  // (1) Fold `{#if <const>}` blocks (constant fold) and narrow if/else-if chains against
  // the known value sets (value-set narrowing); remember every region we deleted/unwrapped.
  // `seedDead` pre-loads the reverse-removal regions so every pass below (fold,
  // ternary, substitution) treats them as already-dead and never edits inside.
  const dead: Span[] = seedDead ? [...seedDead] : [];
  // `pruned` is the subset of dead regions that genuinely VANISH from the output
  // (deleted `{#if}` arms + reverse/unread removals), as opposed to `dead`, which
  // also holds collapse spans whose kept arm is re-emitted verbatim.  Only the
  // vanished regions may be excluded from the CSS possible-class set (§3): a
  // node inside a re-emitted kept arm still renders, so its class still counts.
  const pruned: Span[] = seedDead ? [...seedDead] : [];
  foldIfBlocks(model.ast.fragment, localEnv, localSetEnv, code, s, dead, pruned);

  // (1b) Fold template ternaries `{cond ? a : b}` whose `cond` is a provable
  // constant down to the taken arm.  This runs BEFORE substitution: the taken
  // arm is re-emitted verbatim and the whole ternary span is marked dead, so the
  // substitution pass below leaves identifiers inside it alone (a sub-range
  // overwrite inside an already-overwritten span would conflict in MagicString).
  // Mirrors the `{#if}` "collapse to a kept fragment verbatim" handling.
  foldTernaries(model.ast.fragment, localEnv, code, s, dead);

  // (2) Substitute any surviving references to a folded prop with its literal.
  // Narrowed (set) props are genuinely dynamic and are NOT substituted; we only
  // walk `localEnv` (constFold). Substitution still reaches references inside KEPT
  // narrowed arms because those arms are left as original text (only dead arms
  // are removed), so a constFold prop used inside a surviving arm is handled.
  const refs = collectPropRefs(model, localEnv, dead);
  for (const [name, value] of localEnv) {
    for (const ref of refs.get(name) ?? [])
      s.overwrite(ref.start, ref.end, foldReplacement(ref, value));
  }

  // (3) Drop the folded (constFold) props from the `$props()` signature, together
  // with any unread declared props — one {@link dropProps} call so
  // consecutive dropped properties tile cleanly.  Narrowed props stay (still
  // used/dynamic).  Only the folded set is RETURNED: phase 2 removes call-site
  // attributes for folded props, while unread props are handled spread-aware by
  // the reverse/unread phase, so they must not leak into phase 2.
  const droppable = new Set(env.keys()); // every surviving ref is an expression position
  const signatureDrop =
    extraDrops && extraDrops.size > 0 ? new Set([...droppable, ...extraDrops]) : droppable;
  dropProps(model, signatureDrop, s);

  // (4) CSS rule removal (docs §3 "value-set narrowing", "CSS (shaker 独自の価値)"): drop
  // `<style>` rules targeting a class the component can provably never produce
  // given the value sets.  Sound and independent of the branch edits above:
  // it only reads the possible class set and removes rules no element can match.
  // Svelte's own unused-CSS pruning still runs afterwards on what remains.
  //
  // CSS removal reads the value sets through the plan; rebuild a plan view whose
  // `constFold`/`narrow` are the ENVIRONMENTS we actually folded with (for monomorphization a
  // call site's extra literals shrink the possible class set further), reusing
  // `cssPlan` for everything else (id, valueSets of untouched props).
  // CSS matches the value-set maps against TEMPLATE identifiers (`class={alias}`),
  // so it too reads the LOCAL-keyed environments.
  const cssView: ComponentPlan = {
    ...cssPlan,
    constFold: localEnv,
    narrow: localSetEnv,
  };
  shakeCss(model, cssView, s, pruned);

  if (outDead) outDead.push(...dead);
  return droppable;
}

/**
 * Fold `{#if}` blocks and narrow if/else-if chains in one pass.  Each chain's
 * decision comes from the shared {@link decideChain} (same predicate the
 * analysis fixpoint uses); here we turn that decision into MagicString edits.
 * `dead` accumulates the deleted regions so later passes skip them.
 *
 * The walk threads each chain's parent fragment (for sibling lookup) and whether
 * it sits in a preserved-whitespace context (`<pre>`/`<textarea>` ancestor, or a
 * component-level `<svelte:options preserveWhitespace>`).  {@link applyChain}
 * needs both to keep the RENDERED whitespace unchanged when a chain disappears:
 * Svelte trims a whitespace-only text node at a fragment edge but keeps one
 * between two rendering nodes, so naively deleting a chain that separated two
 * nodes (or splicing in an arm whose own edge whitespace was trimmed) would lose
 * or gain a space.
 */
function foldIfBlocks(
  fragment: AnyNode,
  env: Map<string, Literal>,
  setEnv: Map<string, Literal[]>,
  code: string,
  s: MagicString,
  dead: Span[],
  /** Accumulates only the genuinely-removed spans, for CSS pruning (§3). */
  pruned: Span[],
): void {
  walk<{ parent: AnyNode | null; preserve: boolean; element: string | null }>(
    fragment,
    { parent: null, preserve: hasPreserveWhitespaceOption(fragment), element: null },
    {
      _(node, { state, next }) {
        if (node.type !== 'IfBlock') {
          // Descend, recording this node as the children's parent, whether it
          // opens a preserved-whitespace context, and the content-model element
          // their seam would land in (for the `{" "}` validity check).
          next({
            parent: node,
            preserve: state.preserve || isPreserveElement(node),
            element: childParentElement(node, state.element),
          });
          return;
        }
        // `elseif` IfBlocks are the *continuation* of a chain we already own from
        // its head; skip them so we never edit the same chain twice. Also skip any
        // block already inside a region we removed (a dead arm we descended into).
        if (node.elseif || inSpans(node, dead)) return;
        const decision = decideChain(node, env, setEnv);
        applyChain(decision, env, code, s, dead, pruned, {
          parent: state.parent,
          // `state.parent` is the Fragment that holds this chain (the walk sets a
          // node as its children's parent), so its `nodes` are the chain's siblings.
          index: state.parent?.nodes?.indexOf(node) ?? -1,
          preserve: state.preserve,
          element: state.element,
        });
        // kept head: descend for nested blocks. The `{#if}` is transparent to the
        // content model, so children stay in the same parent element.
        if (decision.recurse)
          next({ parent: node, preserve: state.preserve, element: state.element });
        // otherwise the subtree is gone or re-emitted verbatim — do not recurse.
      },
    },
  );
}

/** Realize one {@link decideChain} decision as MagicString edits, keeping the
 * rendered whitespace at the chain's seam unchanged (see {@link foldIfBlocks}). */
function applyChain(
  decision: ReturnType<typeof decideChain>,
  env: Map<string, Literal>,
  code: string,
  s: MagicString,
  dead: Span[],
  /** Genuinely-removed spans for CSS pruning (§3). */
  pruned: Span[],
  ctx: ChainContext,
): void {
  // `decision.removed` is the chain's never-rendered region in EVERY outcome: the
  // dead arms, the dead prefix before a promoted head, or the parts around a kept
  // arm — never the kept arm itself.  So it is exactly what CSS may exclude, even
  // when the chain collapses to a verbatim-re-emitted arm whose span joins `dead`.
  for (const r of decision.removed) pruned.push(r);
  if (decision.kept) {
    // The chain collapses to a single surviving fragment, re-emitted verbatim.
    // Because we overwrite the whole chain span in one shot, the later
    // substitution pass cannot reach folded-prop references *inside* the kept
    // fragment (a sub-range edit in an overwritten span conflicts), and those
    // props are about to be dropped from the signature — so we must substitute
    // them into the emitted text HERE, or they would become dangling
    // references.  {@link substitutedSlice} does exactly that.
    let text = fragmentSource(decision.kept, env, code);
    // The arm's own leading/trailing whitespace runs were block-fragment edges
    // (trimmed) in the original, but become INNER once spliced into the parent
    // fragment — keeping them would GAIN a space.  Strip them.  Under preserved
    // whitespace nothing was trimmed, so splice verbatim.
    if (!ctx.preserve) text = text.replace(/^\s+|\s+$/g, '');
    // A kept arm that is empty or pure whitespace renders nothing, exactly like a
    // full chain removal — route through the same seam handling so a separating
    // space is neither lost nor spuriously kept.
    if (text === '' && !ctx.preserve) {
      removeChain([decision.span], decision.span, code, s, dead, ctx);
      return;
    }
    s.overwrite(decision.span[0], decision.span[1], text);
    dead.push(decision.span);
    return;
  }
  // The chain renders nothing (no surviving arm): delete it, compensating the
  // seam so a space that separated two siblings is not lost.
  if (isFullRemoval(decision)) {
    removeChain(decision.removed, decision.span, code, s, dead, ctx);
    return;
  }
  // Otherwise the `{#if}` structure is kept (head survives, or a `{:else if}` is
  // promoted): the chain still renders in place, so the outer seam is unchanged —
  // only delete the dead regions.  `removed` ranges and `headerRewrite` are
  // disjoint (the prefix ends exactly where the promoted header begins).
  for (const [a, b] of decision.removed) {
    s.remove(a, b);
    dead.push([a, b]);
  }
  // If a `{:else if}` was promoted to the new head, rewrite its header.
  if (decision.headerRewrite) {
    const { from, to, text } = decision.headerRewrite;
    s.overwrite(from, to, text);
  }
}

/** True when a chain folds away entirely (its whole span is the only removal). */
function isFullRemoval(decision: ReturnType<typeof decideChain>): boolean {
  return (
    decision.kept === undefined &&
    decision.removed.length === 1 &&
    decision.removed[0]![0] === decision.span[0] &&
    decision.removed[0]![1] === decision.span[1]
  );
}

/**
 * Fold template ternaries `{cond ? a : b}` to their taken arm when `cond` is a
 * provable constant under `env` (constFold).  Only the outer-most foldable
 * ternary in any nesting is rewritten: its taken arm is re-emitted verbatim and
 * its whole span recorded in `dead`, so neither the substitution pass nor an
 * inner fold touches it again (a sub-range edit inside an overwritten span would
 * conflict in MagicString).
 *
 * Soundness: a JS conditional only ever evaluates the taken arm at runtime, so
 * dropping the untaken arm is observation-preserving even if that arm had side
 * effects — they would never have run.  We fold only when `evaluate` *proves*
 * the test (no guessing), and we leave value-set (`narrow`) props alone since
 * those are genuinely dynamic.
 */
function foldTernaries(
  fragment: AnyNode,
  env: Map<string, Literal>,
  code: string,
  s: MagicString,
  dead: Span[],
): void {
  if (env.size === 0) return; // ternaries fold only against known constants
  walk<null>(fragment, null, {
    ConditionalExpression(node, { next }) {
      // Skip ternaries inside an already-removed/overwritten region (e.g. a dead
      // `{#if}` arm, or an outer ternary we just folded): editing them would
      // conflict, and they no longer appear in the output anyway.
      if (inSpans(node, dead)) return;
      const test = evaluate(node.test, env);
      if (!test.known) {
        next(); // test not provable: keep this ternary, but inner ones may fold
        return;
      }
      const taken = test.value ? node.consequent : node.alternate;
      // A taken arm always exists for a well-formed ConditionalExpression; guard
      // defensively so a malformed tree never produces a bad slice.
      if (!taken) {
        next();
        return;
      }
      // Emit the taken arm verbatim, but with any folded-prop references inside
      // it already substituted: those props get dropped from the signature, so a
      // raw slice would dangle (see {@link substitutedSlice}).
      s.overwrite(
        node.start,
        node.end,
        substitutedSlice(taken.start, taken.end, [taken], env, code),
      );
      dead.push([node.start, node.end]); // emitted verbatim -> off-limits, no recurse
    },
  });
}

function removeCallSiteAttributes(
  model: FileModel,
  dropped: Map<ComponentId, Set<string>>,
  s: MagicString,
  editedSpans: Span[],
  ownerEnv: ReadonlyMap<string, Literal>,
): void {
  walk<null>(model.ast.fragment, null, {
    Component(node, { next }) {
      // This `<Child/>` sits inside a branch phase 1 already removed/overwrote;
      // its source (attributes included) is gone, so editing it now would overlap
      // that edit ("Cannot split a chunk that has already been edited").  Skip the
      // whole subtree — every nested call site is in the same dead region.
      if (editedSpans.length > 0 && inSpans(node, editedSpans)) return;
      const childId = node.name ? model.imports.get(node.name) : undefined;
      const drop = childId ? dropped.get(childId) : undefined;
      if (drop && drop.size > 0) {
        for (const attr of node.attributes ?? []) {
          if (attr.type !== 'Attribute' || !attr.name || !drop.has(attr.name)) continue;
          if (!isSideEffectFree(attr.value, ownerEnv)) continue;
          s.remove(...attrSpanWithSpace(model.code, attr));
        }
      }
      next();
    },
  });
}

/**
 * A call-site attribute is safe to delete only if its value has no side effects:
 * boolean shorthand / plain text / a literal expression, OR a forwarded
 * expression that the OWNER's fold env proves constant (`prop={ownerConst}`,
 * `prop={ownerConst === 'x' ? … : …}`).  The latter was substituted to a literal
 * in phase 1, so deleting the attribute is exactly as sound as for a literal —
 * and it is the interprocedural pass-through's cleanup (docs §13.1).
 *
 * NOT the same predicate as reverse.ts's {@link isSideEffectFreeValue}, though
 * both gate an attribute removal on the value being effect-free: this pass removes
 * a DECLARED prop the child folded away, so it requires the value to be a proven
 * CONSTANT (`evaluate(expr, ownerEnv).known`) — a bare non-folded identifier is
 * kept.  The reverse pass removes an UNDECLARED input the child never reads, where
 * a bare identifier read is already safe to drop, so it allows that instead of an
 * env fold.  The allow-lists (and the `null` case) genuinely differ; do not merge.
 */
function isSideEffectFree(value: unknown, ownerEnv: ReadonlyMap<string, Literal>): boolean {
  if (value === true || value == null) return true;
  const parts = attrValueParts(value);
  return parts.every((part) => {
    if (part.type === 'Text') return true;
    if (part.type === 'ExpressionTag')
      return part.expression?.type === 'Literal' || evaluate(part.expression, ownerEnv).known;
    return false;
  });
}
