//! Reverse analysis (docs §PR4): drop the call-site inputs a child component can
//! NEVER read.  The Rust port of reverse.ts — an input a child does not declare
//! (and cannot capture via `...rest`) is invisible to it, so the attribute /
//! `{#snippet}` block / body content supplying it is dead at every call site.
//!
//! Like the TS engine, this is a transform phase, not a fixpoint input: not
//! re-analyzing after a removal can only over-count call sites (the sound
//! direction).

use serde_json::Value;
use std::collections::{HashMap, HashSet};

use crate::ast::*;
use crate::plan::{Model, Plans};
use crate::props::ReachableInputs;
use crate::transform::MagicEdit;

/// One reverse removal at a call site.  `component` is the `<Child>` node (so the
/// apply pass can skip a site folded away in phase 1); `[start, end)` is the
/// attribute/body/snippet CONTENT span (used both to protect phase 1 and as the
/// removal base); `eat_leading_space` widens the removal by one space for an
/// attribute, keeping the tag tidy.
pub(crate) struct ReverseOp {
    pub(crate) component: Value,
    pub(crate) start: i64,
    pub(crate) end: i64,
    pub(crate) eat_leading_space: bool,
}

/// Every reverse removal `model` (as an owner) can make against its children's
/// reachable-input sets.  Gated on the child having a precisely-known set and not
/// being bailed; a bailed OWNER is handled by the caller (it makes no edits).
pub(crate) fn collect_reverse_removals(
    model: &Model,
    models_by_id: &HashMap<&str, &Model>,
    plans: &Plans,
) -> Vec<ReverseOp> {
    let mut ops = Vec::new();
    walk(get(&model.ast, "fragment"), &mut |node| {
        if !str_eq(node, "type", "Component") {
            return;
        }
        let child_id = match node.get("name").and_then(Value::as_str).and_then(|n| model.imports.get(n)) {
            Some(c) => c,
            None => return,
        };
        let child = match models_by_id.get(child_id.as_str()) {
            Some(c) => *c,
            None => return,
        };
        let plan = match plans.get(child_id) {
            Some(p) => p,
            None => return,
        };
        if plan.bail {
            return;
        }
        // Only when the child's reachable set is precisely known (not ALL).
        if let ReachableInputs::Names(reachable) = &child.reachable_inputs {
            collect_site_removals(node, reachable, &mut ops);
        }
    });
    ops
}

fn collect_site_removals(node: &Value, reachable: &HashSet<String>, ops: &mut Vec<ReverseOp>) {
    let attrs = arr(node, "attributes");
    // A spread may set ANY prop (including `children`), so nothing at this site is
    // provably unread.
    if attrs.iter().any(|a| type_of(a) == Some("SpreadAttribute")) {
        return;
    }

    // (a) Undeclared attributes with a side-effect-free value.  `bind:` is a
    // `BindDirective` (not an `Attribute`), so it — and `on:`/`use:`/`let:`/
    // `class:`/`style:` directives — is left untouched by the `Attribute` filter.
    for attr in attrs {
        if type_of(attr) != Some("Attribute") {
            continue;
        }
        let name = match attr.get("name").and_then(Value::as_str) {
            Some(n) => n,
            None => continue,
        };
        if reachable.contains(name) {
            continue; // declared -> the child reads it
        }
        if !is_reverse_removable_value(get(attr, "value")) {
            continue;
        }
        ops.push(ReverseOp { component: node.clone(), start: off(attr, "start"), end: off(attr, "end"), eat_leading_space: true });
    }

    // (b) Body content: `children` for any non-snippet content, plus a prop per
    // `{#snippet foo}`.  Drop the ones the child never reads; snippets are handled
    // per-block even when `children` is unread (either may be read while the other
    // is not).
    let children_reachable = reachable.contains("children");
    for bn in arr(get(node, "fragment"), "nodes") {
        if type_of(bn) == Some("SnippetBlock") {
            let expr = get(bn, "expression");
            if str_eq(expr, "type", "Identifier") {
                if let Some(sname) = expr.get("name").and_then(Value::as_str) {
                    if !reachable.contains(sname) {
                        ops.push(ReverseOp { component: node.clone(), start: off(bn, "start"), end: off(bn, "end"), eat_leading_space: false });
                    }
                }
            }
            continue;
        }
        if children_reachable {
            continue;
        }
        // Whitespace-only text and comments render nothing (do not synthesize
        // `children`), so there is nothing to remove.
        if type_of(bn) == Some("Comment") {
            continue;
        }
        if type_of(bn) == Some("Text") && crate::props::text_data(bn).trim().is_empty() {
            continue;
        }
        ops.push(ReverseOp { component: node.clone(), start: off(bn, "start"), end: off(bn, "end"), eat_leading_space: false });
    }
}

/// A call-site attribute value with no observable evaluation side effect: a
/// boolean shorthand, static text, or a single literal / bare-identifier
/// expression (`x={foo}`, `x={undefined}`).  Mirrors `isSideEffectFreeValue`.
fn is_reverse_removable_value(value: &Value) -> bool {
    if value == &Value::Bool(true) {
        return true; // boolean shorthand
    }
    if value.is_null() {
        return false;
    }
    let single;
    let parts: &[Value] = match value.as_array() {
        Some(a) => a,
        None => {
            single = [value.clone()];
            &single
        }
    };
    if parts.is_empty() {
        return false;
    }
    if parts.len() > 1 {
        return parts.iter().all(|p| type_of(p) == Some("Text")); // static concat only
    }
    match type_of(&parts[0]) {
        Some("Text") => true,
        Some("ExpressionTag") => {
            matches!(type_of(get(&parts[0], "expression")), Some("Literal") | Some("Identifier"))
        }
        _ => false,
    }
}

/// The content spans phase 1 must not edit inside (seeded into its dead spans).
pub(crate) fn protect_spans(ops: &[ReverseOp]) -> Vec<Span> {
    ops.iter().map(|op| (op.start, op.end)).collect()
}

/// Apply the reverse removals for one owner.  Skips a site folded away in phase 1
/// (its `<Child>` node is inside an edited region), and an op contained in an
/// already-applied removal (a nested call site inside a removed body), so no two
/// removals overlap — matching `applyReverseRemovals`.
pub(crate) fn apply_reverse_removals(ops: &[ReverseOp], edits: &mut MagicEdit, edited_spans: &[Span]) {
    let mut spans: Vec<Span> = Vec::new();
    for op in ops {
        if !edited_spans.is_empty() && in_spans(&op.component, edited_spans) {
            continue;
        }
        let mut start = op.start;
        if op.eat_leading_space
            && start > 0
            && matches!(edits.unit_at((start - 1) as usize), Some(c) if c == b' ' as u16 || c == b'\t' as u16)
        {
            start -= 1;
        }
        spans.push((start, op.end));
    }
    // Widest-first at a shared start so a container is applied before what it holds.
    spans.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)));
    let mut covered_end = -1i64;
    for (s, e) in spans {
        if s < covered_end {
            continue; // inside an already-removed span
        }
        edits.remove(s as usize, e as usize);
        covered_end = e;
    }
}
