//! If/else-if chain dead-span analysis (dead.ts `decideChain` / `computeDeadSpans`):
//! the single source of truth shared by the analysis and the transform.

use serde_json::Value;

use crate::ast::*;
use crate::eval::{evaluate_with_sets, Env, SetEnv};

pub(crate) struct ChainArm {
    pub(crate) block: Value,
    pub(crate) test: Value,
    pub(crate) consequent: Value,
}

pub(crate) fn collect_chain(top: &Value) -> (Vec<ChainArm>, Option<Value>) {
    let mut arms = Vec::new();
    let mut cur = Some(top.clone());
    let mut else_frag = None;
    while let Some(c) = cur {
        arms.push(ChainArm {
            block: c.clone(),
            test: get(&c, "test").clone(),
            consequent: get(&c, "consequent").clone(),
        });
        let alt = get(&c, "alternate").clone();
        // `{:else if}` = an alternate Fragment whose only node is an elseif IfBlock.
        let elseif = if str_eq(&alt, "type", "Fragment") {
            let nodes = arr(&alt, "nodes");
            if nodes.len() == 1 && str_eq(&nodes[0], "type", "IfBlock") && nodes[0].get("elseif") == Some(&Value::Bool(true)) {
                Some(nodes[0].clone())
            } else {
                None
            }
        } else {
            None
        };
        if let Some(e) = elseif {
            cur = Some(e);
        } else {
            if str_eq(&alt, "type", "Fragment") {
                else_frag = Some(alt);
            }
            cur = None;
        }
    }
    (arms, else_frag)
}

pub(crate) fn fragment_span(fragment: &Value) -> Option<Span> {
    let nodes = fragment.get("nodes").and_then(Value::as_array)?;
    if nodes.is_empty() {
        return None;
    }
    Some((off(&nodes[0], "start"), off(&nodes[nodes.len() - 1], "end")))
}

pub(crate) fn around_kept(span: Span, inner: Option<Span>) -> Vec<Span> {
    match inner {
        None => vec![span],
        Some((is, ie)) => {
            let mut out = Vec::new();
            if span.0 < is {
                out.push((span.0, is));
            }
            if ie < span.1 {
                out.push((ie, span.1));
            }
            out
        }
    }
}

pub(crate) fn consequent_end(consequent: &Value, fallback: i64) -> i64 {
    match consequent.get("nodes").and_then(Value::as_array) {
        Some(n) if !n.is_empty() => off(&n[n.len() - 1], "end"),
        _ => fallback,
    }
}

pub(crate) fn dead_tail(arms: &[ChainArm], truth: &[Option<bool>], from: usize) -> Vec<Span> {
    let mut removed = Vec::new();
    for i in (from + 1)..arms.len() {
        if truth[i] != Some(false) {
            continue;
        }
        let arm = &arms[i];
        let end = if i + 1 < arms.len() {
            off(&arms[i + 1].block, "start")
        } else {
            consequent_end(&arm.consequent, off(&arm.block, "end"))
        };
        removed.push((off(&arm.block, "start"), end));
    }
    removed
}

/// The full fold decision for one if/else-if chain — the single source of truth
/// shared by the analysis (dead spans) and the transform (edits), so they can
/// never disagree on what folds (the §2.1 soundness invariant).
pub(crate) struct ChainDecision {
    pub(crate) span: Span,
    pub(crate) removed: Vec<Span>,
    /// Consequent/else fragment to re-emit verbatim when the chain collapses.
    pub(crate) kept: Option<Value>,
    pub(crate) recurse: bool,
    /// Promote a surviving `{:else if}` to `{#if}`: replace `[from,to)` with `text`.
    pub(crate) header_rewrite: Option<(i64, i64, String)>,
}

pub(crate) fn decide_chain(top: &Value, env: &Env, set_env: &SetEnv) -> ChainDecision {
    let (arms, else_frag) = collect_chain(top);
    let span: Span = (off(top, "start"), off(top, "end"));
    let truth: Vec<Option<bool>> = arms
        .iter()
        .map(|a| evaluate_with_sets(&a.test, env, set_env).map(|lit| lit.is_truthy()))
        .collect();
    let is_true = |t: Option<bool>| t == Some(true);
    let is_false = |t: Option<bool>| t == Some(false);

    // (a) first provably-true arm with all earlier provably-false -> collapse.
    let mut all_earlier_false = true;
    for i in 0..arms.len() {
        if is_true(truth[i]) && all_earlier_false {
            return ChainDecision {
                span,
                removed: around_kept(span, fragment_span(&arms[i].consequent)),
                kept: Some(arms[i].consequent.clone()),
                recurse: false,
                header_rewrite: None,
            };
        }
        if !is_false(truth[i]) {
            all_earlier_false = false;
        }
    }

    // (b) keep arms not provably false.
    let first_kept = truth.iter().position(|t| !is_false(*t));
    match first_kept {
        None => {
            if let Some(ef) = else_frag {
                ChainDecision {
                    span,
                    removed: around_kept(span, fragment_span(&ef)),
                    kept: Some(ef),
                    recurse: false,
                    header_rewrite: None,
                }
            } else {
                ChainDecision { span, removed: vec![span], kept: None, recurse: false, header_rewrite: None }
            }
        }
        Some(0) => ChainDecision {
            span,
            removed: dead_tail(&arms, &truth, 0),
            kept: None,
            recurse: true,
            header_rewrite: None,
        },
        Some(k) => {
            let kept_block = &arms[k].block;
            let kept_start = off(kept_block, "start");
            let mut removed = vec![(span.0, kept_start)];
            removed.extend(dead_tail(&arms, &truth, k));
            ChainDecision {
                span,
                removed,
                kept: None,
                recurse: false,
                // `{:else if ` -> `{#if ` (header runs from block start to its test).
                header_rewrite: Some((kept_start, off(&arms[k].test, "start"), "{#if ".to_string())),
            }
        }
    }
}

pub(crate) fn compute_dead_spans(fragment: &Value, env: &Env, set_env: &SetEnv) -> Vec<Span> {
    if env.is_empty() && set_env.is_empty() {
        return Vec::new();
    }
    let mut dead = Vec::new();
    collect_dead(fragment, env, set_env, &mut dead);
    dead
}

pub(crate) fn collect_dead(node: &Value, env: &Env, set_env: &SetEnv, dead: &mut Vec<Span>) {
    match node {
        Value::Array(items) => {
            for v in items {
                collect_dead(v, env, set_env, dead);
            }
        }
        Value::Object(map) => {
            if type_of(node) == Some("IfBlock") {
                // elseif continuations are owned by their head; skip removed regions.
                if node.get("elseif") == Some(&Value::Bool(true)) || in_spans(node, dead) {
                    return;
                }
                let decision = decide_chain(node, env, set_env);
                dead.extend(decision.removed);
                if decision.recurse {
                    for v in map.values() {
                        collect_dead(v, env, set_env, dead);
                    }
                }
                return;
            }
            for v in map.values() {
                collect_dead(v, env, set_env, dead);
            }
        }
        _ => {}
    }
}

/// True when a chain folds away entirely (its whole span is the only removal).
pub(crate) fn is_full_removal(decision: &ChainDecision) -> bool {
    decision.kept.is_none() && decision.removed.len() == 1 && decision.removed[0] == decision.span
}
