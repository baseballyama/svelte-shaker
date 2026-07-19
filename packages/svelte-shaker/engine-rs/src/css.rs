//! CSS rule removal (css.ts): drop `<style>` rules whose class selectors can
//! never be produced by the (bounded) set of classes the template can render.

use serde_json::Value;
use std::collections::HashSet;

use crate::ast::*;
use crate::eval::{evaluate, Env, SetEnv};
use crate::plan::Model;
use crate::props::text_data;
use crate::shake::is_ws_u16;
use crate::transform::MagicEdit;

pub(crate) const MAX_CLASS_COMBOS: usize = 64;

pub(crate) struct PossibleClasses {
    pub(crate) classes: HashSet<String>,
    pub(crate) unbounded: bool,
}

pub(crate) fn is_element_like(t: Option<&str>) -> bool {
    matches!(
        t,
        Some("RegularElement") | Some("SvelteElement") | Some("Component") | Some("SvelteComponent") | Some("SvelteSelf")
    )
}

/// Possible string values of one interpolated `{expr}` in a class attribute, or
/// `None` (UNBOUNDED). A bare set-var enumerates its set; else it must fold.
pub(crate) fn expression_strings(expr: &Value, env: &Env, set_env: &SetEnv) -> Option<HashSet<String>> {
    if str_eq(expr, "type", "Identifier") {
        if let Some(name) = expr.get("name").and_then(Value::as_str) {
            if let Some(set) = set_env.get(name) {
                return Some(set.iter().map(|v| v.to_dom_string()).collect());
            }
        }
    }
    evaluate(expr, env).map(|v| {
        let mut s = HashSet::new();
        s.insert(v.to_dom_string());
        s
    })
}

pub(crate) fn part_strings(part: &Value, env: &Env, set_env: &SetEnv) -> Option<HashSet<String>> {
    match type_of(part) {
        Some("Text") => {
            let mut s = HashSet::new();
            s.insert(text_data(part));
            Some(s)
        }
        Some("ExpressionTag") => expression_strings(get(part, "expression"), env, set_env),
        _ => None, // unknown part kind -> conservative
    }
}

/// Class tokens contributed by one `class=` attribute value, or `None` (UNBOUNDED).
pub(crate) fn class_tokens_from_attr(value: &Value, env: &Env, set_env: &SetEnv) -> Option<HashSet<String>> {
    if value == &Value::Bool(true) {
        return None; // `{class}` shorthand -> dynamic
    }
    if value.is_null() {
        return Some(HashSet::new());
    }
    let single;
    let parts: &[Value] = match value.as_array() {
        Some(a) => a,
        None => {
            single = [value.clone()];
            &single
        }
    };
    let mut combos: Vec<String> = vec![String::new()];
    for part in parts {
        let frags = part_strings(part, env, set_env)?;
        let mut next = Vec::new();
        for base in &combos {
            for f in &frags {
                next.push(format!("{base}{f}"));
                if next.len() > MAX_CLASS_COMBOS {
                    return None;
                }
            }
        }
        combos = next;
    }
    let mut tokens = HashSet::new();
    for combo in &combos {
        for tok in combo.split_whitespace() {
            tokens.insert(tok.to_string());
        }
    }
    Some(tokens)
}

/// The dead spans sorted by start (ascending), for `contained_in_dead`'s binary
/// search.  Copies so the caller's slice is left untouched.
fn sorted_by_start(dead: &[Span]) -> Vec<Span> {
    let mut v = dead.to_vec();
    v.sort_by_key(|s| s.0);
    v
}

/// Is `node`'s span fully inside any dead span?  `dead_starts` is sorted by start,
/// so the only candidate that can contain `node.start` is the rightmost span whose
/// start is `<= node.start` (binary search) — O(log m) per node.  A miss from an
/// unusual nesting only UNDER-prunes (the sound, conservative direction).  Mirrors
/// `containedInDead` in css.ts.
fn contained_in_dead(node: &Value, dead_starts: &[Span]) -> bool {
    if dead_starts.is_empty() {
        return false;
    }
    let start = off(node, "start");
    // partition_point gives the count of spans with start <= `start`; the last of
    // them is the sole candidate.
    let cand = dead_starts.partition_point(|s| s.0 <= start);
    cand > 0 && dead_starts[cand - 1].1 >= off(node, "end")
}

pub(crate) fn compute_possible_classes(model: &Model, env: &Env, set_env: &SetEnv, dead: &[Span]) -> PossibleClasses {
    let mut classes = HashSet::new();
    let mut unbounded = false;
    let dead_starts = sorted_by_start(dead);
    walk(get(&model.ast, "fragment"), &mut |node| {
        // Fully inside a deleted region -> never renders, so it carries no class.
        // (A contained node's descendants are contained too, so a flat walk skips
        // them just the same — the TS engine additionally prunes the subtree, which
        // is a perf-only difference that yields the identical class set.)
        if contained_in_dead(node, &dead_starts) {
            return;
        }
        if !is_element_like(type_of(node)) {
            return;
        }
        for attr in arr(node, "attributes") {
            match type_of(attr) {
                Some("SpreadAttribute") => unbounded = true,
                Some("ClassDirective") => {
                    if let Some(n) = attr.get("name").and_then(Value::as_str) {
                        classes.insert(n.to_string());
                    }
                }
                Some("Attribute") if attr.get("name").and_then(Value::as_str) == Some("class") => {
                    match class_tokens_from_attr(get(attr, "value"), env, set_env) {
                        None => unbounded = true,
                        Some(toks) => classes.extend(toks),
                    }
                }
                _ => {}
            }
        }
    });
    PossibleClasses { classes, unbounded }
}

pub(crate) fn has_global(rule: &Value) -> bool {
    let mut found = false;
    walk(rule, &mut |n| {
        if str_eq(n, "type", "PseudoClassSelector") && n.get("name").and_then(Value::as_str) == Some("global") {
            found = true;
        }
    });
    found
}

pub(crate) fn is_complex_dead(complex: &Value, possible: &HashSet<String>) -> bool {
    let mut dead = false;
    for rel in arr(complex, "children") {
        for sel in arr(rel, "selectors") {
            if str_eq(sel, "type", "ClassSelector") {
                if let Some(n) = sel.get("name").and_then(Value::as_str) {
                    if !possible.contains(n) {
                        dead = true;
                    }
                }
            }
        }
    }
    dead
}

pub(crate) fn is_rule_dead(rule: &Value, possible: &HashSet<String>) -> bool {
    if has_global(rule) {
        return false;
    }
    let complexes = get(rule, "prelude").get("children").and_then(Value::as_array);
    match complexes {
        Some(c) if !c.is_empty() => c.iter().all(|complex| is_complex_dead(complex, possible)),
        _ => false,
    }
}

pub(crate) fn remove_rule(rule: &Value, siblings: &[Value], edits: &mut MagicEdit) {
    let i = match siblings.iter().position(|s| same_node(s, rule)) {
        Some(i) => i,
        None => return,
    };
    let floor = if i > 0 { off(&siblings[i - 1], "end") } else { 0 };
    let mut start = off(rule, "start");
    while start > floor && edits.unit_at((start - 1) as usize).map(is_ws_u16).unwrap_or(false) {
        start -= 1;
    }
    edits.remove(start as usize, off(rule, "end") as usize);
}

pub(crate) fn shake_css(model: &Model, env: &Env, set_env: &SetEnv, edits: &mut MagicEdit, dead: &[Span]) {
    let css = get(&model.ast, "css");
    let children = match css.get("children").and_then(Value::as_array) {
        Some(c) => c.clone(),
        None => return,
    };
    let possible = compute_possible_classes(model, env, set_env, dead);
    if possible.unbounded {
        return; // cannot bound the class set -> removing nothing is the only sound choice
    }
    for child in &children {
        if type_of(child) == Some("Rule") && is_rule_dead(child, &possible.classes) {
            remove_rule(child, &children, edits);
        }
    }
}
