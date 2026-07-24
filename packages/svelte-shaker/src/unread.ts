import { walk, type AnyNode } from './parse.js';
import type { ComponentId, ComponentPlan } from './ir.js';
import type { FileModel, PropDecl } from './analyze.js';
import { isSideEffectFreeValue, attrOp, type ReverseOp } from './reverse.js';

// ----------------------------------------------------------------------
// Unread declared props.  Where the reverse pass removes
// call-site inputs a child NEVER DECLARES, this removes inputs a child DECLARES
// but never READS ({@link FileModel.unreadDeclaredProps}).  Two independent,
// each-sound transforms:
//
//   (a) call-site attribute removal — the same rule the reverse pass uses (no
//       spread on the site, a side-effect-free value, never a `bind:`), gated
//       additionally on the child prop's DEFAULT being side-effect-free.  This
//       last gate is the subtle one: Svelte 5 evaluates a `$props()` destructure
//       default EAGERLY when the prop is omitted, so removing the attribute would
//       newly run the default — sound only when that default cannot be observed
//       (absent / a literal / `undefined`).
//
//   (b) declaration drop — additionally strip the prop from the child's
//       `$props()` signature when it is safe: no `...rest` (else a spread-passed
//       value would flow into `rest`), a side-effect-free default, and every call
//       site either carries a spread (the child ignores the prop with no rest) or
//       passes the prop (a)-removably.
//
// The removals share the reverse pass's protect / seedDead / editedSpans
// machinery in the transform, so a reverse removal and an unread removal never collide
// (one names a prop the child does not declare, the other one it does).
// ----------------------------------------------------------------------

/** The unread work for one whole-program transform pass. */
export interface UnreadPlan {
  /** Per OWNER: the call-site attribute removals (a), in `ReverseOp` shape so the
   * transform folds them into the same phase as the reverse removals. */
  removals: Map<ComponentId, ReverseOp[]>;
  /** Per CHILD: the EXTERNAL prop names to drop from its `$props()` signature (b). */
  drops: Map<ComponentId, Set<string>>;
}

/**
 * Compute every unread-declared removal (a) and declaration drop (b) the program
 * admits, from the current `plans` (so a bailed/force-bailed component — owner or
 * child — is naturally excluded and the revert cascade un-applies on re-run).
 */
export function collectUnread(
  models: Map<ComponentId, FileModel>,
  plans: Map<ComponentId, ComponentPlan>,
): UnreadPlan {
  const removals = new Map<ComponentId, ReverseOp[]>();
  const drops = new Map<ComponentId, Set<string>>();

  // Per child, the effective unread set: declared-but-unread props MINUS any the
  // const-fold / narrow machinery already owns (a folded prop is dropped and has
  // its attributes removed by the existing phases — handling it here too would
  // double-edit).  What remains is exactly the props with a `top`/`dynamic` value
  // set, where the unread-declared pass adds value the folder cannot: the child
  // ignores them, so they go even though their value is not a single known constant.
  const effective = new Map<ComponentId, Set<string>>();
  for (const [id, model] of models) {
    if (model.unreadDeclaredProps.size === 0) continue;
    const plan = plans.get(id);
    if (!plan || plan.bail) continue;
    const set = new Set<string>();
    for (const name of model.unreadDeclaredProps) {
      if (!plan.constFold.has(name) && !plan.narrow.has(name)) set.add(name);
    }
    if (set.size > 0) effective.set(id, set);
  }
  if (effective.size === 0) return { removals, drops };

  // Index each effective child's declarations by external name ONCE, so neither
  // the eligibility seed below nor `classifySite` does a per-name linear `find`
  // over `props` inside a loop (CLAUDE.md: build a Map, not a search-in-loop).
  const declByChild = new Map<ComponentId, Map<string, PropDecl>>();
  for (const [id, names] of effective) {
    const byName = new Map<string, PropDecl>();
    for (const decl of models.get(id)!.props ?? []) {
      if (names.has(decl.name)) byName.set(decl.name, decl);
    }
    declByChild.set(id, byName);
  }

  // (b) eligibility, seeded per child prop from the child-local structural gates
  // (no `...rest`, side-effect-free default).  A call site then VETOES a prop that
  // it passes in a way (a) cannot remove — a `bind:`, or a non-spread site with a
  // side-effecting value — because then the attribute must stay, so dropping the
  // declaration would leave the prop half-removed / a dangling `bind:`.
  const dropEligible = new Map<ComponentId, Map<string, boolean>>();
  for (const [id, names] of effective) {
    const model = models.get(id)!;
    const decls = declByChild.get(id)!;
    const perProp = new Map<string, boolean>();
    for (const name of names) {
      const decl = decls.get(name);
      const structural = decl !== undefined && !model.hasRestProp && isHarmlessDefault(decl);
      perProp.set(name, structural);
    }
    dropEligible.set(id, perProp);
  }

  // One walk over every non-bailed owner's call sites builds both (a) and (b):
  // it emits the removable attributes and lets each site veto the drop of a prop
  // it holds non-removably.
  for (const [ownerId, model] of models) {
    const ownerPlan = plans.get(ownerId);
    if (!ownerPlan || ownerPlan.bail) continue; // a bailed owner makes no edits
    walk<null>(model.ast.fragment, null, {
      Component(node, { next }) {
        const childId = node.name ? model.imports.get(node.name) : undefined;
        const names = childId ? effective.get(childId) : undefined;
        const decls = childId ? declByChild.get(childId) : undefined;
        if (childId && names && decls)
          classifySite(node, childId, names, model, decls, dropEligible, removals);
        next();
      },
    });
  }

  // (b): a prop is droppable when it survived every site's veto (and had the
  // structural gates).  A child with NO call sites keeps every `true` here — safe,
  // since the child does not read the prop, so its own render is unchanged whether
  // it is declared or not (and a consumer outside the `.svelte` graph, if any,
  // bails the child).
  for (const [id, perProp] of dropEligible) {
    const set = new Set<string>();
    for (const [name, ok] of perProp) if (ok) set.add(name);
    if (set.size > 0) drops.set(id, set);
  }
  return { removals, drops };
}

/**
 * Classify one `<Child .../>` site against the child's effective unread set:
 * push each (a)-removable attribute, and veto (b) for any prop the site passes
 * non-removably.  A site with a spread never yields an (a) removal (a spread may
 * re-set the prop, so the parent expression is not provably the only writer) but
 * does NOT veto (b) — with no `...rest` the dropped child ignores the prop.
 */
function classifySite(
  node: AnyNode,
  childId: ComponentId,
  names: Set<string>,
  owner: FileModel,
  decls: Map<string, PropDecl>,
  dropEligible: Map<ComponentId, Map<string, boolean>>,
  removals: Map<ComponentId, ReverseOp[]>,
): void {
  const attrs = node.attributes ?? [];
  const hasSpread = attrs.some((a) => a.type === 'SpreadAttribute');
  const perProp = dropEligible.get(childId)!;
  const veto = (name: string) => perProp.set(name, false);

  for (const attr of attrs) {
    if (!attr.name || !names.has(attr.name)) continue;
    // `bind:p` is a two-way write contract: never removable, and it forbids
    // dropping the declaration at ALL (the bind would dangle) — even at a spread
    // site.
    if (attr.type === 'BindDirective') {
      veto(attr.name);
      continue;
    }
    if (attr.type !== 'Attribute') continue; // on:/use:/let:/class:/style: are not props
    // Removing the attribute makes the child's DEFAULT run (Svelte evaluates it
    // eagerly when the prop is omitted).  A non-harmless default (a call, …) must
    // therefore keep its attribute — and cannot be dropped either — so this prop
    // is left entirely alone at every site.
    const decl = decls.get(attr.name);
    if (!decl || !isHarmlessDefault(decl)) continue;
    if (hasSpread) continue; // spread site: keep the attribute; do not veto the drop
    if (!isSideEffectFreeValue(attr.value)) {
      // A side-effecting value must keep running, so the attribute stays — which
      // means the declaration cannot be cleanly dropped either.
      veto(attr.name);
      continue;
    }
    pushRemoval(owner.id, attrOp(node, attr, owner.code), removals);
  }
}

/** A declared prop whose default, if it ran, has no observable effect — so
 * removing its call-site attribute (which makes the default run) is sound.  True
 * for an absent default, a literal (`p = 3`), or the `undefined` identifier. */
function isHarmlessDefault(decl: { defaultExpr?: AnyNode | undefined }): boolean {
  const d = decl.defaultExpr;
  if (d === undefined) return true;
  if (d.type === 'Literal') return true;
  return d.type === 'Identifier' && d.name === 'undefined';
}

function pushRemoval(
  owner: ComponentId,
  op: ReverseOp,
  removals: Map<ComponentId, ReverseOp[]>,
): void {
  const list = removals.get(owner);
  if (list) list.push(op);
  else removals.set(owner, [op]);
}
