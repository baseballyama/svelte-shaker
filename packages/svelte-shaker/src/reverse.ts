import type MagicString from 'magic-string';
import { walk, type AnyNode } from './parse.js';
import type { ComponentId, ComponentPlan } from './ir.js';
import type { FileModel } from './analyze.js';
import { inSpans, type Span } from './dead.js';

// ----------------------------------------------------------------------
// Reverse analysis (docs §PR4): drop the call-site inputs a child component can
// NEVER read.  Where the rest of the engine reasons call-site -> child (what
// value does the child receive?), this reasons child -> call-site: an input the
// child does not declare (and cannot capture via `...rest`) is invisible to it,
// so passing it has no observable effect — the attribute, `{#snippet}` block, or
// body content that supplies it is dead and can be removed at every call site.
//
// The value is a bundle-size cascade: `<Icon icon={Heavy}/>` where `Icon` never
// reads `icon` loses the attribute, the owner's `import Heavy` goes unreferenced,
// and the bundler drops the module — a deletion no single-file tool can make.
//
// This runs as a transform phase, NOT a fixpoint input: not re-analyzing after a
// removal is sound because it can only OVER-count call sites (a `<X/>` inside a
// removed snippet still counts toward X's profile, so X folds no more than it
// would have), which is the conservative direction.
// ----------------------------------------------------------------------

/** One reverse removal at a call site. */
export interface ReverseOp {
  /** The `<Child .../>` node, so the caller can skip a site phase 1 folded away. */
  component: AnyNode;
  /** Source range to delete (an attribute with its leading space, a body node, or
   * a `{#snippet}` block). */
  remove: Span;
  /** Region phase 1 must not edit inside — the attribute/body/snippet CONTENT,
   * about to be deleted whole.  Seeded into the body pass's dead spans so no
   * fold/substitution edit lands in a span this phase then removes. */
  protect: Span;
}

/**
 * Every reverse removal `model` (as an owner) can make: for each `<Child .../>`
 * it renders, the attributes / snippet blocks / body content supplying an input
 * the child can never read.  Gated on the child having a precisely-known
 * reachable-input set and not being bailed; a bailed OWNER is handled by the
 * caller (it makes no edits at all).
 */
export function collectReverseRemovals(
  model: FileModel,
  models: Map<ComponentId, FileModel>,
  plans: Map<ComponentId, ComponentPlan>,
): ReverseOp[] {
  const ops: ReverseOp[] = [];
  walk<null>(model.ast.fragment, null, {
    Component(node, { next }) {
      const childId = node.name ? model.imports.get(node.name) : undefined;
      const child = childId ? models.get(childId) : undefined;
      const childPlan = childId ? plans.get(childId) : undefined;
      // Only when the child's reachable set is precisely known AND the child is
      // not bailed (a bail means its prop profile is unknowable — docs §4.1).
      if (child && childPlan && !childPlan.bail && child.reachableInputs.kind === 'names') {
        collectSiteRemovals(node, child.reachableInputs.names, model.code, ops);
      }
      next();
    },
  });
  return ops;
}

/** Collect the removals at ONE call site against the child's reachable names. */
function collectSiteRemovals(
  node: AnyNode,
  reachable: Set<string>,
  code: string,
  ops: ReverseOp[],
): void {
  const attrs = node.attributes ?? [];
  // A spread may set ANY prop — including `children` — so nothing at this site is
  // provably unread (docs §PR4: spread があるサイトでは本体除去もしない).
  if (attrs.some((a) => a.type === 'SpreadAttribute')) return;

  // (a) Undeclared attributes whose value is side-effect-free.  `bind:` is a
  // two-way write contract and is a `BindDirective` (not an `Attribute`), so the
  // `Attribute`-only filter already leaves it — and `on:`/`use:`/`let:`/`class:`/
  // `style:` directives — untouched.
  for (const attr of attrs) {
    if (attr.type !== 'Attribute' || !attr.name) continue;
    if (reachable.has(attr.name)) continue; // declared -> the child reads it
    if (!isSideEffectFreeValue(attr.value)) continue; // may have an evaluation effect
    ops.push(attrOp(node, attr, code));
  }

  // (b) Body content.  Svelte 5 synthesizes `children` from any non-snippet body
  // content and a prop named `foo` from each `{#snippet foo(...)}`; drop the ones
  // the child never reads.  Snippets are handled per-block even when `children` is
  // unread, since a snippet may be read while `children` is not (and vice versa).
  const childrenReachable = reachable.has('children');
  for (const bn of node.fragment?.nodes ?? []) {
    if (bn.type === 'SnippetBlock') {
      const sname = bn.expression?.type === 'Identifier' ? bn.expression.name : undefined;
      if (sname && !reachable.has(sname)) ops.push(spanOp(node, bn));
      continue;
    }
    if (childrenReachable) continue;
    // Whitespace-only text and comments render nothing and do not synthesize
    // `children`, so there is nothing to remove — skip to avoid needless edits.
    if (bn.type === 'Comment') continue;
    if (bn.type === 'Text' && isWhitespace(code, bn)) continue;
    ops.push(spanOp(node, bn));
  }
}

/**
 * A call-site attribute value is safe to delete only if evaluating it has no
 * observable side effect (docs §PR4).  Conservative allow-list: a boolean
 * shorthand, a static text value, or a single expression that is a literal or a
 * BARE identifier read (`x={foo}`, including `x={undefined}`).  Anything else — a
 * call, member access (a getter), template/logical/conditional expression, or a
 * function expression — is kept, since it could run code or read a getter.
 */
function isSideEffectFreeValue(value: unknown): boolean {
  if (value === true) return true; // boolean shorthand `x`
  if (value == null) return false;
  const parts = (Array.isArray(value) ? value : [value]) as AnyNode[];
  if (parts.length === 0) return false;
  if (parts.length > 1) return parts.every((p) => p.type === 'Text'); // static concat only
  const part = parts[0]!;
  if (part.type === 'Text') return true;
  if (part.type !== 'ExpressionTag') return false;
  const expr = part.expression;
  return expr?.type === 'Literal' || expr?.type === 'Identifier';
}

/** Removal of an attribute plus one leading space/tab, keeping the tag tidy. */
function attrOp(component: AnyNode, attr: AnyNode, code: string): ReverseOp {
  let start = attr.start;
  if (code[start - 1] === ' ' || code[start - 1] === '\t') start -= 1;
  return { component, remove: [start, attr.end], protect: [attr.start, attr.end] };
}

/** Removal of a whole node (body node or `{#snippet}` block) by its own span. */
function spanOp(component: AnyNode, node: AnyNode): ReverseOp {
  return { component, remove: [node.start, node.end], protect: [node.start, node.end] };
}

function isWhitespace(code: string, node: AnyNode): boolean {
  return /^\s*$/.test(code.slice(node.start, node.end));
}

/**
 * Apply the reverse removals for one owner, editing `s`.  Two skips keep it from
 * colliding with phase 1's edits:
 *  - a site whose `<Child>` node sits inside a region phase 1 removed/overwrote
 *    (a folded-away `{#if}` arm) is skipped — its source is already gone;
 *  - an op contained in an already-applied removal is skipped, so a nested call
 *    site inside a removed body (`<Outer><Inner a={x}/></Outer>` with `Outer`'s
 *    `children` unread) is not double-edited.
 * The contained-op skip is O(n log n): sort by start, then widest-first, and drop
 * any op that begins before the last applied removal ended.
 */
export function applyReverseRemovals(ops: ReverseOp[], s: MagicString, editedSpans: Span[]): void {
  const live =
    editedSpans.length > 0 ? ops.filter((op) => !inSpans(op.component, editedSpans)) : ops;
  // Widest-first at a shared start so a container is applied before what it holds.
  live.sort((a, b) => a.remove[0] - b.remove[0] || b.remove[1] - a.remove[1]);
  let coveredEnd = -1;
  for (const op of live) {
    if (op.remove[0] < coveredEnd) continue; // inside an already-removed span
    s.remove(op.remove[0], op.remove[1]);
    coveredEnd = op.remove[1];
  }
}
