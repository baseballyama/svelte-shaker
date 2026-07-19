//! Unread declared props (docs §PR7): the Rust port of unread.ts.  Where the
//! reverse pass removes call-site inputs a child NEVER DECLARES, this removes
//! inputs a child DECLARES but never READS ({@link Model::unread_declared}):
//!   (a) remove the side-effect-free call-site attribute (reusing the reverse
//!       pass's rule, gated additionally on the child prop's DEFAULT being
//!       side-effect-free — Svelte evaluates a destructure default eagerly when
//!       the prop is omitted, so removing the attribute would newly run it), and
//!   (b) drop the prop from the child's `$props()` signature when safe.
//! Its removals merge into the reverse phase, sharing the protect/apply machinery.

use serde_json::Value;
use std::collections::{HashMap, HashSet};

use crate::ast::*;
use crate::plan::{Model, Plans};
use crate::props::PropDecl;
use crate::reverse::{is_reverse_removable_value, ReverseOp};

/// The unread work for one whole-program transform pass.
pub(crate) struct UnreadPlan {
    /// Per OWNER: the (a) call-site attribute removals, in `ReverseOp` shape.
    pub(crate) removals: HashMap<String, Vec<ReverseOp>>,
    /// Per CHILD: the EXTERNAL prop names to (b) drop from its `$props()`.
    pub(crate) drops: HashMap<String, HashSet<String>>,
}

/// A declared prop whose default, if it ran, has no observable effect (absent, a
/// literal, or the `undefined` identifier) — so removing its call-site attribute
/// (which makes the default run) is sound.  Mirrors `isHarmlessDefault`.
fn is_harmless_default(default: &Value) -> bool {
    if default.is_null() {
        return true;
    }
    match type_of(default) {
        Some("Literal") => true,
        Some("Identifier") => default.get("name").and_then(Value::as_str) == Some("undefined"),
        _ => false,
    }
}

pub(crate) fn collect_unread(models: &[Model], models_by_id: &HashMap<&str, &Model>, plans: &Plans) -> UnreadPlan {
    let mut removals: HashMap<String, Vec<ReverseOp>> = HashMap::new();
    let mut drops: HashMap<String, HashSet<String>> = HashMap::new();

    // Per child, the effective unread set: declared-but-unread props MINUS any the
    // const-fold / narrow machinery already owns (handling those here too would
    // double-edit).  What remains are the `top`/`dynamic` props the folder cannot
    // touch but the child still ignores.
    let mut effective: HashMap<String, HashSet<String>> = HashMap::new();
    for m in models {
        if m.unread_declared.is_empty() {
            continue;
        }
        let plan = match plans.get(&m.id) {
            Some(p) if !p.bail => p,
            _ => continue,
        };
        let folded: HashSet<&str> = plan
            .const_fold
            .iter()
            .map(|(k, _)| k.as_str())
            .chain(plan.narrow.iter().map(|(k, _)| k.as_str()))
            .collect();
        let set: HashSet<String> =
            m.unread_declared.iter().filter(|n| !folded.contains(n.as_str())).cloned().collect();
        if !set.is_empty() {
            effective.insert(m.id.clone(), set);
        }
    }
    if effective.is_empty() {
        return UnreadPlan { removals, drops };
    }

    // Index each effective child's declarations by external name ONCE, so neither
    // the eligibility seed nor `classify_site` does a per-name linear `find` over
    // `props` inside a loop (mirrors unread.ts's `declByChild`).
    let mut decl_by_child: HashMap<&str, HashMap<&str, &PropDecl>> = HashMap::new();
    for (id, names) in &effective {
        if let Some(pi) = &models_by_id[id.as_str()].props_info {
            let mut by_name: HashMap<&str, &PropDecl> = HashMap::new();
            for decl in &pi.props {
                if names.contains(decl.name.as_str()) {
                    by_name.insert(decl.name.as_str(), decl);
                }
            }
            decl_by_child.insert(id.as_str(), by_name);
        }
    }

    // (b) eligibility, seeded from the child-local structural gates (no `...rest`,
    // a harmless default).  A call site then vetoes a prop it passes non-removably.
    let mut drop_eligible: HashMap<String, HashMap<String, bool>> = HashMap::new();
    for (id, names) in &effective {
        let has_rest = models_by_id[id.as_str()].props_info.as_ref().is_some_and(|p| p.has_rest);
        let decls = decl_by_child.get(id.as_str());
        let mut per = HashMap::new();
        for name in names {
            let decl = decls.and_then(|m| m.get(name.as_str()));
            let structural = decl.is_some_and(|d| !has_rest && is_harmless_default(&d.default));
            per.insert(name.clone(), structural);
        }
        drop_eligible.insert(id.clone(), per);
    }

    // One walk over every non-bailed owner's call sites builds both (a) and (b).
    for owner in models {
        match plans.get(&owner.id) {
            Some(p) if !p.bail => {}
            _ => continue, // a bailed owner makes no edits
        }
        let mut components: Vec<Value> = Vec::new();
        walk(get(&owner.ast, "fragment"), &mut |node| {
            if str_eq(node, "type", "Component") {
                components.push(node.clone());
            }
        });
        for node in &components {
            let child_id =
                match node.get("name").and_then(Value::as_str).and_then(|n| owner.imports.get(n)) {
                    Some(c) => c,
                    None => continue,
                };
            let names = match effective.get(child_id) {
                Some(n) => n,
                None => continue,
            };
            let decls = match decl_by_child.get(child_id.as_str()) {
                Some(d) => d,
                None => continue,
            };
            classify_site(node, child_id, names, owner, decls, &mut drop_eligible, &mut removals);
        }
    }

    // (b): a prop is droppable when it survived every site's veto (and had the
    // structural gates).  A child with NO call sites keeps every `true` — safe,
    // since it does not read the prop, so its own render is unchanged.
    for (id, per) in &drop_eligible {
        let set: HashSet<String> =
            per.iter().filter(|(_, ok)| **ok).map(|(k, _)| k.clone()).collect();
        if !set.is_empty() {
            drops.insert(id.clone(), set);
        }
    }
    UnreadPlan { removals, drops }
}

/// Classify one `<Child .../>` site against the child's effective unread set:
/// push each (a)-removable attribute, and veto (b) for any prop the site passes
/// non-removably.  A spread site never yields an (a) removal but does NOT veto (b).
fn classify_site(
    node: &Value,
    child_id: &str,
    names: &HashSet<String>,
    owner: &Model,
    decls: &HashMap<&str, &PropDecl>,
    drop_eligible: &mut HashMap<String, HashMap<String, bool>>,
    removals: &mut HashMap<String, Vec<ReverseOp>>,
) {
    let attrs = arr(node, "attributes");
    let has_spread = attrs.iter().any(|a| type_of(a) == Some("SpreadAttribute"));
    for attr in attrs {
        let name = match attr.get("name").and_then(Value::as_str) {
            Some(n) if names.contains(n) => n,
            _ => continue,
        };
        // `bind:p` is a two-way write contract: never removable, and it forbids
        // dropping the declaration at ALL — even at a spread site.
        if type_of(attr) == Some("BindDirective") {
            veto(drop_eligible, child_id, name);
            continue;
        }
        if type_of(attr) != Some("Attribute") {
            continue; // on:/use:/let:/class:/style: are not props
        }
        // Removing the attribute makes the child's DEFAULT run (Svelte evaluates it
        // eagerly when the prop is omitted).  A non-harmless default keeps its
        // attribute — and cannot be dropped either — so leave the prop alone.
        let harmless = decls.get(name).is_some_and(|d| is_harmless_default(&d.default));
        if !harmless {
            continue;
        }
        if has_spread {
            continue; // spread site: keep the attribute; do not veto the drop
        }
        if !is_reverse_removable_value(get(attr, "value")) {
            // A side-effecting value must keep running -> the attribute stays -> the
            // declaration cannot be cleanly dropped either.
            veto(drop_eligible, child_id, name);
            continue;
        }
        removals.entry(owner.id.clone()).or_default().push(ReverseOp {
            component: node.clone(),
            start: off(attr, "start"),
            end: off(attr, "end"),
            eat_leading_space: true,
        });
    }
}

fn veto(drop_eligible: &mut HashMap<String, HashMap<String, bool>>, child_id: &str, name: &str) {
    if let Some(per) = drop_eligible.get_mut(child_id) {
        if let Some(v) = per.get_mut(name) {
            *v = false;
        }
    }
}
