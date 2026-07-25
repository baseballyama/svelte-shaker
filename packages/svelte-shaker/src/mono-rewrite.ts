// ----------------------------------------------------------------------
// Monomorphization phase 3: rewrite each monomorphization-bound `<Child …>` call
// site to import a specialized variant from a virtual module.  Runs on top of the
// shared base phases (from transform.ts) and only edits regions phase 2 never
// touches — a bound tag's NAME and its frozen-prop attributes.
// ----------------------------------------------------------------------

import type MagicString from 'magic-string';
import { attrSpanWithSpace, type AnyNode } from './parse.js';
import type { ComponentId, ComponentPlan, Literal } from './ir.js';
import type { FileModel } from './model.js';
import { runBasePhases, emit } from './transform.js';

/**
 * Like `transformAll`, but additionally rewrites the monomorphization-bound call sites in
 * each owner to import a specialized variant from a virtual module.  The base
 * phases are unchanged (so files with no binding are byte-identical to
 * `transformAll`); phase 3 only edits regions phase 2 never touches — a
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
    s.remove(...attrSpanWithSpace(code, attr));
  }
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
