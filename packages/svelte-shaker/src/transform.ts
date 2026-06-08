import MagicString from 'magic-string';
import { walk, type AnyNode } from './parse';
import type { ComponentId, ComponentPlan, Literal } from './ir';
import type { FileModel } from './analyze';
import { decideChain, inSpans, type Span } from './dead';
import { evaluate } from './eval';
import { shakeCss } from './css';

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

/**
 * Phases 1–2, shared by {@link transformAll} and {@link transformAllWithMono}:
 * fold each component body and drop its folded props (phase 1), then strip the
 * now-pointless attribute at every call site of a dropped prop (phase 2).
 * Returns the per-file MagicStrings, ready for the optional L2 phase 3.
 */
function runBasePhases(
  models: Map<ComponentId, FileModel>,
  plans: Map<ComponentId, ComponentPlan>,
): Map<ComponentId, MagicString> {
  const strings = new Map<ComponentId, MagicString>();
  const dropped = new Map<ComponentId, Set<string>>();
  /** Regions phase 1 edited per component — phase 2 must not edit inside them. */
  const editedSpans = new Map<ComponentId, Span[]>();

  // Phase 1 — component bodies: fold dead branches, drop folded props.
  for (const model of models.values()) {
    const s = new MagicString(model.code);
    strings.set(model.id, s);
    const plan = plans.get(model.id)!;
    if (plan.bail) {
      dropped.set(model.id, new Set());
      continue;
    }
    const result = transformBody(model, plan, s);
    dropped.set(model.id, result.dropped);
    editedSpans.set(model.id, result.dead);
  }
  // Phase 2 — call sites: remove attributes for props the child actually dropped,
  // skipping any call site phase 1 folded away (its attributes went with it).
  for (const model of models.values()) {
    removeCallSiteAttributes(
      model,
      dropped,
      strings.get(model.id)!,
      editedSpans.get(model.id) ?? [],
    );
  }
  return strings;
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
 * Like {@link transformAll}, but additionally rewrites the L2-bound call sites in
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
  // Phase 3 — L2: rewrite each bound `<Child …>` site to a specialized variant.
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
): { dropped: Set<string>; dead: Span[] } {
  const dead: Span[] = [];
  const dropped = shakeBody(model, plan.constFold, plan.narrow, plan, s, dead);
  return { dropped, dead };
}

/**
 * Slim one component's body against the given fold (`env`) and narrow (`setEnv`)
 * environments, editing `s` in place, and return the set of props that left the
 * `$props()` signature.  Factored out of {@link transformBody} so L2
 * monomorphization (see `mono.ts`) can re-run the SAME pipeline with an augmented
 * `env` (a call site's extra literal props) on a fresh MagicString — guaranteeing
 * a specialized residual is produced by exactly the audited L0/L1/L1.5 machinery,
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
   * edited").  Mono (L2) does not pass it; it edits fresh strings.
   */
  outDead?: Span[],
): Set<string> {
  // Nothing to fold (L1) and nothing to narrow (L1.5): no branch/prop edits.
  // CSS removal still depends only on the value sets the plan carries, so a
  // component with no foldable/narrowable prop produces an empty class set
  // bound and removes nothing — leave it untouched entirely.
  if (env.size === 0 && setEnv.size === 0) return new Set();
  const code = model.code;

  // (1) Fold `{#if <const>}` blocks (L1) and narrow if/else-if chains against
  // the known value sets (L1.5); remember every region we deleted/unwrapped.
  const dead: Span[] = [];
  foldIfBlocks(model.ast.fragment, env, setEnv, code, s, dead);

  // (1b) Fold template ternaries `{cond ? a : b}` whose `cond` is a provable
  // constant down to the taken arm.  This runs BEFORE substitution: the taken
  // arm is re-emitted verbatim and the whole ternary span is marked dead, so the
  // substitution pass below leaves identifiers inside it alone (a sub-range
  // overwrite inside an already-overwritten span would conflict in MagicString).
  // Mirrors the `{#if}` "collapse to a kept fragment verbatim" handling.
  foldTernaries(model.ast.fragment, env, code, s, dead);

  // (2) Substitute any surviving references to a folded prop with its literal.
  // Narrowed (set) props are genuinely dynamic and are NOT substituted; we only
  // walk `env` (constFold). Substitution still reaches references inside KEPT
  // narrowed arms because those arms are left as original text (only dead arms
  // are removed), so a constFold prop used inside a surviving arm is handled.
  const refs = collectPropRefs(model, env, dead);
  for (const [name, value] of env) {
    const lit = literalSource(value);
    for (const ref of refs.get(name) ?? [])
      s.overwrite(ref.start, ref.end, ref.head + lit + ref.tail);
  }

  // (3) Drop only the folded (constFold) props from the `$props()` signature.
  // Narrowed props stay in the signature — they are still used/dynamic.
  const droppable = new Set(env.keys()); // every surviving ref is an expression position
  dropProps(model, droppable, s);

  // (4) CSS rule removal (docs §3 "L1.5", "CSS (shaker 独自の価値)"): drop
  // `<style>` rules targeting a class the component can provably never produce
  // given the value sets.  Sound and independent of the branch edits above:
  // it only reads the possible class set and removes rules no element can match.
  // Svelte's own unused-CSS pruning still runs afterwards on what remains.
  //
  // CSS removal reads the value sets through the plan; rebuild a plan view whose
  // `constFold`/`narrow` are the ENVIRONMENTS we actually folded with (for L2 a
  // call site's extra literals shrink the possible class set further), reusing
  // `cssPlan` for everything else (id, valueSets of untouched props).
  const cssView: ComponentPlan = {
    ...cssPlan,
    constFold: env,
    narrow: setEnv,
  };
  shakeCss(model, cssView, s);

  if (outDead) outDead.push(...dead);
  return droppable;
}

/**
 * Fold `{#if}` blocks and narrow if/else-if chains in one pass.  Each chain's
 * decision comes from the shared {@link decideChain} (same predicate the
 * analysis fixpoint uses); here we turn that decision into MagicString edits.
 * `dead` accumulates the deleted regions so later passes skip them.
 */
function foldIfBlocks(
  fragment: AnyNode,
  env: Map<string, Literal>,
  setEnv: Map<string, Literal[]>,
  code: string,
  s: MagicString,
  dead: Span[],
): void {
  walk<null>(fragment, null, {
    IfBlock(node, { next }) {
      // `elseif` IfBlocks are the *continuation* of a chain we already own from
      // its head; skip them so we never edit the same chain twice. Also skip any
      // block already inside a region we removed (a dead arm we descended into).
      if (node.elseif || inSpans(node, dead)) return;
      const decision = decideChain(node, env, setEnv);
      applyChain(decision, env, code, s);
      // When the chain collapses to a kept fragment we overwrite the WHOLE span
      // in one shot, so the whole span must be off-limits to later edits (a
      // sub-range overwrite inside it would conflict in MagicString). When the
      // structure is kept, only the genuinely-removed regions are off-limits —
      // surviving arms must stay editable for prop substitution.
      if (decision.kept) dead.push(decision.span);
      else for (const r of decision.removed) dead.push(r);
      if (decision.recurse) next(); // kept head: descend for nested blocks
      // otherwise the subtree is gone or re-emitted verbatim — do not recurse.
    },
  });
}

/** Realize one {@link decideChain} decision as MagicString edits. */
function applyChain(
  decision: ReturnType<typeof decideChain>,
  env: Map<string, Literal>,
  code: string,
  s: MagicString,
): void {
  if (decision.kept) {
    // The chain collapses to a single surviving fragment, re-emitted verbatim.
    // Because we overwrite the whole chain span in one shot, the later
    // substitution pass cannot reach folded-prop references *inside* the kept
    // fragment (a sub-range edit in an overwritten span conflicts), and those
    // props are about to be dropped from the signature — so we must substitute
    // them into the emitted text HERE, or they would become dangling
    // references.  {@link substitutedSlice} does exactly that.
    s.overwrite(decision.span[0], decision.span[1], fragmentSource(decision.kept, env, code));
    return;
  }
  // Otherwise the `{#if}` structure is kept: delete the dead regions in place.
  // `removed` ranges and `headerRewrite` are disjoint (the prefix ends exactly
  // where the promoted header begins), so they never overlap.
  for (const [a, b] of decision.removed) s.remove(a, b);
  // If a `{:else if}` was promoted to the new head, rewrite its header.
  if (decision.headerRewrite) {
    const { from, to, text } = decision.headerRewrite;
    s.overwrite(from, to, text);
  }
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
    out += ref.head + literalSource(env.get(ref.name)!) + ref.tail;
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
  return { start: node.start, end: node.end, head: '', tail: '' };
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
          if (!isSideEffectFree(attr.value)) continue;
          removeAttrWithSpace(model.code, attr, s);
        }
      }
      next();
    },
  });
}

/** A call-site attribute is safe to delete only if its value has no side effects. */
function isSideEffectFree(value: unknown): boolean {
  if (value === true || value == null) return true;
  const parts = (Array.isArray(value) ? value : [value]) as AnyNode[];
  return parts.every((part) => {
    if (part.type === 'Text') return true;
    if (part.type === 'ExpressionTag') return part.expression?.type === 'Literal';
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

function literalSource(value: Literal): string {
  if (value === undefined) return 'undefined';
  return JSON.stringify(value);
}
