import MagicString from 'magic-string';
import { walk, type AnyNode } from './parse.js';
import type { ComponentId, ComponentPlan, Literal } from './ir.js';
import { remapToLocalNames, type FileModel } from './analyze.js';
import { decideChain, inSpans, type Span } from './dead.js';
import { collectReverseRemovals, applyReverseRemovals, type ReverseOp } from './reverse.js';
import { collectUnread } from './unread.js';
import { evaluate } from './eval.js';
import { shakeCss } from './css.js';

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
 * Phases 1–2, shared by {@link transformAll} and {@link transformAllWithMono}:
 * fold each component body and drop its folded props (phase 1), then strip the
 * now-pointless attribute at every call site of a dropped prop (phase 2).
 * Returns the per-file MagicStrings, ready for the optional monomorphization phase 3.
 */
function runBasePhases(
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
function emit(
  models: Map<ComponentId, FileModel>,
  strings: Map<ComponentId, MagicString>,
): Record<ComponentId, string> {
  const out: Record<ComponentId, string> = {};
  for (const model of models.values()) out[model.id] = strings.get(model.id)!.toString();
  return out;
}

/**
 * Like {@link transformAll}, but additionally rewrites the monomorphization-bound call sites in
 * each owner to import a specialized variant from a virtual module.  The base
 * phases are unchanged (so files with no binding are byte-identical to
 * {@link transformAll}); phase 3 only edits regions phase 2 never touches — a
 * bound `<Child …>` tag's NAME, and the frozen-prop attributes (which are
 * disjoint from the dropped-prop attributes phase 2 removes, because a frozen
 * prop is by construction NOT in the child's app-wide `constFold`).
 *
 * `variantImport(variantId)` maps a variant id to the module specifier the
 * rewritten `import` should reference (the Shell supplies the virtual id).
 */
export function transformAllWithMono(
  models: Map<ComponentId, FileModel>,
  plans: Map<ComponentId, ComponentPlan>,
  bindings: MonoBinding[],
  variantImport: (variantId: string) => string,
): Record<ComponentId, string> {
  const strings = runBasePhases(models, plans);
  // Phase 3 — monomorphization: rewrite each bound `<Child …>` site to a specialized variant.
  rewriteBoundCallSites(models, bindings, variantImport, strings);
  return emit(models, strings);
}

/** Minimal binding shape the rewrite needs (matches `mono.ts` CallSiteBinding). */
export interface MonoBinding {
  owner: ComponentId;
  node: AnyNode;
  variantId: string;
  /** Props the variant froze — their attributes are removed from the site. */
  foldedProps: Map<string, Literal>;
}

/**
 * Inject one `import` per (owner, variant) and rewrite each bound site's tag name
 * to the imported local, removing the frozen-prop attributes.  A fresh local name
 * `<Child>__shaker_v<n>` is derived from the original tag and the variant index so
 * distinct variants of the same child never collide within one owner.
 */
function rewriteBoundCallSites(
  models: Map<ComponentId, FileModel>,
  bindings: MonoBinding[],
  variantImport: (variantId: string) => string,
  strings: Map<ComponentId, MagicString>,
): void {
  // Group bindings by owner; within an owner, assign each variant id a fresh
  // local import name and remember the imports to inject.
  const byOwner = new Map<ComponentId, MonoBinding[]>();
  for (const b of bindings) {
    const list = byOwner.get(b.owner);
    if (list) list.push(b);
    else byOwner.set(b.owner, [b]);
  }

  for (const [ownerId, list] of byOwner) {
    const model = models.get(ownerId);
    const s = strings.get(ownerId);
    if (!model || !s) continue;

    const localFor = new Map<string, string>(); // variantId -> local import name
    const importsToAdd: Array<{ local: string; spec: string }> = [];
    let counter = 0;

    for (const b of list) {
      const original = b.node.name ?? 'Cmp';
      let local = localFor.get(b.variantId);
      if (local === undefined) {
        local = `${original}__shaker_v${counter++}`;
        localFor.set(b.variantId, local);
        importsToAdd.push({ local, spec: variantImport(b.variantId) });
      }
      rewriteOneSite(model.code, b.node, local, b.foldedProps, s);
    }

    if (importsToAdd.length > 0) injectImports(model, importsToAdd, s);
  }
}

/** Rewrite a single `<Child …>` open (and matching close) tag name + strip frozen attrs. */
function rewriteOneSite(
  code: string,
  node: AnyNode,
  local: string,
  frozen: Map<string, Literal>,
  s: MagicString,
): void {
  const name = node.name;
  if (!name) return;
  // The open tag name sits right after `<` at the node start.
  const openNameStart = node.start + 1;
  if (code.slice(openNameStart, openNameStart + name.length) === name)
    s.overwrite(openNameStart, openNameStart + name.length, local);

  // A non-self-closing component has a `</Name>` whose name we must also rewrite.
  // Find the LAST occurrence of `</name` before node.end (close tags cannot nest
  // for the same element, and the last one is this element's own).
  const closeMarker = `</${name}`;
  const closeIdx = code.lastIndexOf(closeMarker, node.end);
  if (closeIdx >= node.start) {
    const from = closeIdx + 2; // skip `</`
    s.overwrite(from, from + name.length, local);
  }

  // Remove the frozen-prop attributes (the variant hard-codes them).  Only
  // static `Attribute`s are frozen (mono required `!dynamic`), so this never
  // drops a side-effecting expression.
  for (const attr of node.attributes ?? []) {
    if (attr.type !== 'Attribute' || !attr.name || !frozen.has(attr.name)) continue;
    removeAttrWithSpace(code, attr, s);
  }
}

/** Delete an attribute's span plus one preceding space/tab, keeping the tag tidy. */
function removeAttrWithSpace(code: string, attr: AnyNode, s: MagicString): void {
  let start = attr.start;
  if (code[start - 1] === ' ' || code[start - 1] === '\t') start -= 1;
  s.remove(start, attr.end);
}

/**
 * Append the variant imports to the owner's instance `<script>` (or prepend a
 * fresh `<script>` block when the component has none).  Appending after the last
 * existing statement keeps the original imports intact and positions stable.
 */
function injectImports(
  model: FileModel,
  imports: Array<{ local: string; spec: string }>,
  s: MagicString,
): void {
  const lines = imports
    .map((i) => `  import ${i.local} from ${JSON.stringify(i.spec)};`)
    .join('\n');
  const instance = model.ast.instance;
  const body = instance?.content?.body ?? [];
  if (instance && body.length > 0) {
    const last = body[body.length - 1]!;
    s.appendLeft(last.end, `\n${lines}`);
    return;
  }
  if (instance && instance.content) {
    // Empty `<script>`: insert at the program start.
    s.appendLeft(instance.content.start, `\n${lines}\n`);
    return;
  }
  // No instance script at all: prepend a fresh one before everything.
  s.prepend(`<script>\n${lines}\n</script>\n`);
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

/** What {@link applyChain} needs about a chain's position to fix the seam. */
interface ChainContext {
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
function removeChain(
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
function isPreserveElement(node: AnyNode): boolean {
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
function childParentElement(node: AnyNode, current: string | null): string | null {
  if (node.type === 'RegularElement') return node.name ?? null;
  if (PARENT_ELEMENT_RESET.has(node.type)) return null;
  return current;
}

/** True when an `{" "}` seam would be an invalid text child of `element`. */
function isTextFreeParent(element: string | null): boolean {
  return element !== null && TEXT_FREE_PARENTS.has(element);
}

/** Does the component opt into preserved whitespace via `<svelte:options>`? */
function hasPreserveWhitespaceOption(fragment: AnyNode): boolean {
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
  const parts = (Array.isArray(value) ? value : [value]) as AnyNode[];
  return parts.some(
    (p) =>
      p?.type === 'ExpressionTag' &&
      p.expression?.type === 'Literal' &&
      p.expression.value === false,
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

function fragmentSource(
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
function substitutedSlice(
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

/**
 * One folded-prop edit: overwrite source `[start, end)` with
 * `head + <literal> + tail`.  For a plain expression read `head`/`tail` are empty
 * and `[start, end)` is the identifier itself; for a SHORTHAND position they wrap
 * the literal back into the explicit `name={…}` form (see {@link foldRefFor}).
 */
interface FoldRef {
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
function foldReplacement(ref: FoldRef, value: Literal): string {
  const lit = literalSource(value);
  const body = ref.memberObject === true && typeof value === 'number' ? `(${lit})` : lit;
  return ref.head + body + ref.tail;
}

/** Find every folded-prop reference in `model`, outside dead spans, by name. */
function collectPropRefs(
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
function collectFoldRefs(
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

function dropProps(model: FileModel, drop: Set<string>, s: MagicString): void {
  if (!model.props || drop.size === 0) return;
  const remaining = model.props.filter((p) => !drop.has(p.name));

  if (remaining.length === 0 && !model.hasRestProp && model.propsDeclaration) {
    removeWholeLine(model.code, model.propsDeclaration, s); // signature is now empty
    return;
  }
  const properties = model.propsPattern?.properties ?? [];
  // Remove each MAXIMAL RUN of consecutive dropped properties as a single range so
  // the separating commas tile cleanly.  A per-property removal mishandles a
  // trailing comma on the last property and overlaps on consecutive drops, leaving
  // a dangling `,` (invalid `$props()` destructuring).
  const droppedNodes = new Set(model.props.filter((p) => drop.has(p.name)).map((p) => p.property));
  let i = 0;
  while (i < properties.length) {
    if (!droppedNodes.has(properties[i]!)) {
      i++;
      continue;
    }
    let hi = i;
    while (hi + 1 < properties.length && droppedNodes.has(properties[hi + 1]!)) hi++;
    removePropertyRun(model.code, properties, i, hi, s);
    i = hi + 1;
  }
  // Type members live in the disjoint `}: { … }` annotation; remove them per-prop.
  if (model.propsPattern) {
    for (const decl of model.props) {
      if (drop.has(decl.name)) removeTypeMember(model.propsPattern, decl.name, s);
    }
  }
}

/**
 * Delete the run of dropped destructuring properties `properties[lo..hi]` together,
 * absorbing the commas/whitespace so the result stays valid.  When a surviving
 * property follows the run we eat forward to it; otherwise the run reaches the end,
 * so we eat any trailing comma and reach back to the previous surviving property's
 * separator (leaving it with no dangling comma).
 */
function removePropertyRun(
  code: string,
  properties: AnyNode[],
  lo: number,
  hi: number,
  s: MagicString,
): void {
  const first = properties[lo]!;
  const last = properties[hi]!;
  const keptAfter = properties[hi + 1];
  if (keptAfter) {
    s.remove(first.start, keptAfter.start); // run + commas + ws up to the next survivor
    return;
  }
  // Run reaches the end of the pattern: include a trailing comma after the last
  // dropped property if present (so it does not dangle), but NOT the whitespace
  // before `}` when there is none — keep `{ a }` from becoming `{ a}`.  Then drop
  // back to the previous survivor's separator.
  let end = last.end;
  let j = end;
  while (j < code.length && /\s/.test(code[j]!)) j++;
  if (code[j] === ',') end = j + 1;
  const keptBefore = properties[lo - 1];
  s.remove(keptBefore ? keptBefore.end : first.start, end);
}

function removeTypeMember(pattern: AnyNode, name: string, s: MagicString): void {
  const members = pattern.typeAnnotation?.typeAnnotation?.members ?? [];
  const i = members.findIndex((m) => m.key?.type === 'Identifier' && m.key.name === name);
  if (i === -1) return;
  const member = members[i]!;
  const next = members[i + 1];
  const prev = members[i - 1];
  // Members are separated by `;` or `,`; eat one separator with the member.
  if (next) s.remove(member.start, next.start);
  else if (prev) s.remove(prev.end, member.end);
  else s.remove(member.start, member.end);
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
          removeAttrWithSpace(model.code, attr, s);
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
 */
function isSideEffectFree(value: unknown, ownerEnv: ReadonlyMap<string, Literal>): boolean {
  if (value === true || value == null) return true;
  const parts = (Array.isArray(value) ? value : [value]) as AnyNode[];
  return parts.every((part) => {
    if (part.type === 'Text') return true;
    if (part.type === 'ExpressionTag')
      return part.expression?.type === 'Literal' || evaluate(part.expression, ownerEnv).known;
    return false;
  });
}

/**
 * Remove the (now prop-less) `$props()` declaration.  When it is alone on its
 * line — the realistic case for every `.svelte` file — eat the whole line so no
 * blank indentation is left behind.  But if it shares its line with other code
 * (e.g. a hand-minified `let {x}=$props();</script>`), remove ONLY the
 * declaration (plus a trailing `;`) so we never swallow adjacent source.
 */
function removeWholeLine(code: string, node: AnyNode, s: MagicString): void {
  let lineStart = node.start;
  while (lineStart > 0 && code[lineStart - 1] !== '\n') lineStart -= 1;
  let lineEnd = node.end;
  while (lineEnd < code.length && code[lineEnd] !== '\n') lineEnd += 1;

  const prefix = code.slice(lineStart, node.start);
  const suffix = code.slice(node.end, lineEnd);
  if (/^\s*$/.test(prefix) && /^\s*;?\s*$/.test(suffix)) {
    // Alone on the line: remove the line and its trailing newline.
    s.remove(lineStart, lineEnd < code.length ? lineEnd + 1 : lineEnd);
  } else {
    // Shares the line: remove just the declaration (+ a trailing semicolon).
    s.remove(node.start, code[node.end] === ';' ? node.end + 1 : node.end);
  }
}

function setDefault<K, V>(map: Map<K, V[]>, key: K): V[] {
  const arr: V[] = [];
  map.set(key, arr);
  return arr;
}

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
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
