//! If/else-if chain dead-span analysis (dead.ts `decideChain` / `computeDeadSpans`):
//! the single source of truth shared by the analysis and the transform.

use std::collections::HashSet;

use serde_json::Value;

use crate::ast::*;
use crate::eval::{evaluate, evaluate_with_sets, Env, SetEnv};

/// Cap on a narrowed set's size for the `{:else}` exhaustiveness check — mirrors
/// dead.ts `MAX_EXHAUSTIVE_SET` (same intent as css.rs `MAX_CLASS_COMBOS`).
const MAX_EXHAUSTIVE_SET: usize = 64;

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
        Some(0) => {
            let mut removed = dead_tail(&arms, &truth, 0);
            if let Some(else_span) = exhaustive_else_span(&arms, &else_frag, env, set_env) {
                removed.push(else_span);
            }
            ChainDecision { span, removed, kept: None, recurse: true, header_rewrite: None }
        }
        Some(k) => {
            let kept_block = &arms[k].block;
            let kept_start = off(kept_block, "start");
            let mut removed = vec![(span.0, kept_start)];
            removed.extend(dead_tail(&arms, &truth, k));
            if let Some(else_span) = exhaustive_else_span(&arms, &else_frag, env, set_env) {
                removed.push(else_span);
            }
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

/// The removed span for a dead `{:else}` arm proven unreachable by exhaustiveness,
/// or `None` when the else must stay.  Mirrors dead.ts `exhaustiveElseSpan`.
///
/// When a chain ends in `{:else}` and every test is driven by exactly ONE narrowed
/// prop `v` (value set known), the else is dead iff for every value the set can
/// take, some test fires.  We enumerate the set and evaluate each test under a
/// single-value binding `v ↦ c` with the plain constant evaluator: a value is
/// covered only when a test is *provably* TRUE there; one value we cannot settle
/// keeps the else.  Multiple set-vars, zero set-vars, an empty/too-large set, or
/// an empty else all skip the check.
///
/// Soundness: narrow's contract is "at runtime v ∈ set", so if every value makes
/// some test fire the else body is unreachable in every execution.  Fixpoint
/// monotonicity: the set only ever SHRINKS, and a proof over a set holds for every
/// subset, so an else proven dead never revives (a monotone dead-span addition).
fn exhaustive_else_span(arms: &[ChainArm], else_frag: &Option<Value>, env: &Env, set_env: &SetEnv) -> Option<Span> {
    let ef = else_frag.as_ref()?;
    let (_, to) = fragment_span(ef)?; // None when the else renders nothing

    // Exactly one narrowed prop may drive the chain (a cartesian product of two or
    // more sets is out of scope).
    let mut vars: HashSet<String> = HashSet::new();
    for arm in arms {
        collect_set_vars(&arm.test, set_env, &mut vars);
    }
    if vars.len() != 1 {
        return None;
    }
    let v = vars.into_iter().next()?;
    let set = set_env.get(&v)?;
    if set.is_empty() || set.len() > MAX_EXHAUSTIVE_SET {
        return None;
    }

    // The removal starts where the last arm's consequent ends — the offset of the
    // `{:else}` marker.  When that consequent is EMPTY (`{:else if v==='b'}{:else}…`)
    // it has no end offset to anchor on: `consequent_end`'s fallback is the block
    // end, which for the last arm is the whole chain's `{/if}` — past the else
    // content, so the span would invert. We do not back-scan for the `{:else}`
    // token here (out of scope); bail and keep the else.
    let last = arms.last()?;
    if last.consequent.get("nodes").and_then(Value::as_array).is_none_or(|n| n.is_empty()) {
        return None;
    }

    for c in set {
        // env ∪ {v ↦ c}: the plain evaluator treats v as this single literal.
        let mut per_value = env.clone();
        per_value.insert(v.clone(), c.clone());
        let covered =
            arms.iter().any(|a| evaluate(&a.test, &per_value).map(|lit| lit.is_truthy()).unwrap_or(false));
        if !covered {
            return None; // this value reaches the else -> keep it
        }
    }

    // Remove `{:else}` + its content: from the last arm's consequent end (where the
    // `{:else}` marker begins) to the end of the else fragment.
    Some((consequent_end(&last.consequent, off(&last.block, "end")), to))
}

/// Collect identifiers in a test expression that name a set-var (a `set_env` key).
fn collect_set_vars(test: &Value, set_env: &SetEnv, out: &mut HashSet<String>) {
    walk(test, &mut |node| {
        if type_of(node) == Some("Identifier") {
            if let Some(name) = node.get("name").and_then(Value::as_str) {
                if set_env.contains_key(name) {
                    out.insert(name.to_string());
                }
            }
        }
    });
}

// PARITY ORACLE (test-only): the fixpoint calls `compute_dead_spans_ir` (below) in
// production; this Value walk over the svelte/compiler JSON is kept as the differential
// oracle the cargo test pins the IR walk against. Its output is the definition of
// "correct" the IR walk must reproduce, so it stays even though nothing ships it.
#[cfg(test)]
pub(crate) fn compute_dead_spans(fragment: &Value, env: &Env, set_env: &SetEnv) -> Vec<Span> {
    if env.is_empty() && set_env.is_empty() {
        return Vec::new();
    }
    let mut dead = Vec::new();
    collect_dead(fragment, env, set_env, &mut dead);
    dead
}

/// IR-consuming `compute_dead_spans`. The FIND — the per-fixpoint-round
/// cost — runs over the typed IR (the fast walk that replaces the Value fragment
/// re-walk); the per-`{#if}` `decide_chain` stays the Value implementation via the IR
/// IfBlock's `raw` bridge. That split is deliberate and permanent: the hybrid IR types
/// only the template STRUCTURE, keeping embedded JS (the `{#if}` test, `decide_chain`'s
/// evaluation) as Value, and there are few if-blocks per file so the walk — not
/// `decide_chain` — is the hot path. Reproduces `collect_dead` exactly and is pinned
/// byte-for-byte to it by the parity test + the shake corpus.
pub(crate) fn compute_dead_spans_ir(
    fragment: &crate::ir::Fragment,
    env: &Env,
    set_env: &SetEnv,
) -> Vec<Span> {
    if env.is_empty() && set_env.is_empty() {
        return Vec::new();
    }
    let mut dead = Vec::new();
    collect_dead_ir(fragment, env, set_env, &mut dead);
    dead
}

fn span_contained(span: Span, spans: &[Span]) -> bool {
    let (s, e) = span;
    spans.iter().any(|&(a, b)| s >= a && e <= b)
}

fn collect_dead_ir(
    fragment: &crate::ir::Fragment,
    env: &Env,
    set_env: &SetEnv,
    dead: &mut Vec<Span>,
) {
    use crate::ir::Node;
    for node in &fragment.nodes {
        if let Node::IfBlock(b) = node {
            // elseif continuations are owned by their head; skip removed regions —
            // exactly `collect_dead`'s early `return` for such an `{#if}` node.
            let span: Span = (b.span.start as i64, b.span.end as i64);
            if b.elseif || span_contained(span, dead) {
                continue;
            }
            let decision = decide_chain(&b.raw, env, set_env);
            dead.extend(decision.removed);
            if decision.recurse {
                collect_dead_ir(&b.consequent, env, set_env, dead);
                if let Some(alt) = &b.alternate {
                    collect_dead_ir(alt, env, set_env, dead);
                }
            }
        } else {
            // Non-`{#if}` nodes hold no dead-branch decision; descend their child
            // fragments (the only place a nested `{#if}` can live).
            for frag in node.child_fragments() {
                collect_dead_ir(frag, env, set_env, dead);
            }
        }
    }
}

// PARITY ORACLE (test-only): only the test-only `compute_dead_spans` calls this; the
// production IR path uses `collect_dead_ir`. Kept as the Value reference the IR walk is
// pinned against.
#[cfg(test)]
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
