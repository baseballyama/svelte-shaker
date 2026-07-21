//! Constant evaluator + value-set narrowing predicate, ported faithfully from
//! `src/eval.ts`. A total (never-panicking) over-approximation: anything it
//! cannot prove is `None`. The boolean results must be SOUND — `evaluate_with_sets`
//! returns a known value only when it holds for every value in every set var's
//! reachable set (docs/ARCHITECTURE.md §3, §13).

use crate::ast::unwrap_ts_assertions;
use serde_json::Value;
use std::collections::HashMap;
use std::mem::discriminant;

/// A statically-known literal (the Rust counterpart of `ir.ts` `Literal`).
/// `Undefined` is distinct from `Null` and cannot round-trip through JSON, so the
/// env is always built engine-internally.
#[derive(Clone, Debug, PartialEq)]
pub enum Literal {
    Str(String),
    Num(f64),
    Bool(bool),
    Null,
    Undefined,
}

impl Literal {
    /// Read a literal off a `Literal` AST node's `value` (never `undefined` —
    /// source has no `undefined` literal; that is the `undefined` identifier).
    pub fn from_node_value(v: &Value) -> Option<Literal> {
        match v {
            Value::String(s) => Some(Literal::Str(s.clone())),
            Value::Number(n) => Some(Literal::Num(n.as_f64()?)),
            Value::Bool(b) => Some(Literal::Bool(*b)),
            Value::Null => Some(Literal::Null),
            _ => None,
        }
    }

    fn to_number(&self) -> f64 {
        match self {
            Literal::Num(n) => *n,
            Literal::Bool(b) => {
                if *b {
                    1.0
                } else {
                    0.0
                }
            }
            Literal::Null => 0.0,
            Literal::Undefined => f64::NAN,
            Literal::Str(s) => js_string_to_number(s),
        }
    }

    /// Truthiness for an `{#if}` test (JS ToBoolean).
    pub fn is_truthy(&self) -> bool {
        self.to_boolean()
    }

    fn to_boolean(&self) -> bool {
        match self {
            Literal::Num(n) => *n != 0.0 && !n.is_nan(),
            Literal::Str(s) => !s.is_empty(),
            Literal::Bool(b) => *b,
            Literal::Null | Literal::Undefined => false,
        }
    }

    fn to_js_string(&self) -> String {
        match self {
            Literal::Str(s) => s.clone(),
            Literal::Bool(b) => b.to_string(),
            Literal::Null => "null".to_string(),
            Literal::Undefined => "undefined".to_string(),
            Literal::Num(n) => js_number_to_string(*n),
        }
    }

    /// Source text to substitute for a folded reference (`literalSource` in
    /// transform.ts): `undefined`/`null`/`true`/`false` verbatim, numbers via JS
    /// `toString`, strings JSON-quoted.
    pub fn to_source(&self) -> String {
        match self {
            Literal::Undefined => "undefined".to_string(),
            Literal::Null => "null".to_string(),
            Literal::Bool(b) => b.to_string(),
            Literal::Num(n) => js_number_to_string(*n),
            Literal::Str(s) => serde_json::to_string(s).unwrap_or_else(|_| format!("{s:?}")),
        }
    }

    /// How a value renders into a DOM string when interpolated (`String(value)`),
    /// for the CSS possible-class computation.
    pub fn to_dom_string(&self) -> String {
        self.to_js_string()
    }

    /// JSON-serializable form for handing a folded literal back to the Shell.
    /// `Undefined` has no JSON form; callers that can produce it must special-case
    /// it (the plan layer keeps it out of JSON by construction).
    pub fn to_json(&self) -> Value {
        match self {
            Literal::Str(s) => Value::String(s.clone()),
            Literal::Num(n) => serde_json::Number::from_f64(*n).map(Value::Number).unwrap_or(Value::Null),
            Literal::Bool(b) => Value::Bool(*b),
            Literal::Null => Value::Null,
            Literal::Undefined => Value::Null,
        }
    }
}

fn js_string_to_number(s: &str) -> f64 {
    let t = s.trim();
    if t.is_empty() {
        return 0.0;
    }
    if let Some(hex) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        return i64::from_str_radix(hex, 16).map(|v| v as f64).unwrap_or(f64::NAN);
    }
    match t {
        "Infinity" | "+Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        _ => t.parse::<f64>().unwrap_or(f64::NAN),
    }
}

fn js_number_to_string(n: f64) -> String {
    if n.is_nan() {
        "NaN".to_string()
    } else if n.is_infinite() {
        if n > 0.0 { "Infinity".to_string() } else { "-Infinity".to_string() }
    } else {
        // Rust's `{}` for f64 already prints integers without a trailing `.0`
        // (e.g. `2.0 -> "2"`), matching JS Number#toString for the common cases.
        format!("{n}")
    }
}

/// `a === b` (strict): same type, same value. NaN ≠ NaN and +0 === -0 fall out of
/// f64 semantics; differing variants are never equal.
fn strict_eq(a: &Literal, b: &Literal) -> bool {
    match (a, b) {
        (Literal::Str(x), Literal::Str(y)) => x == y,
        (Literal::Num(x), Literal::Num(y)) => x == y,
        (Literal::Bool(x), Literal::Bool(y)) => x == y,
        (Literal::Null, Literal::Null) => true,
        (Literal::Undefined, Literal::Undefined) => true,
        _ => false,
    }
}

/// `a == b` (loose, JS abstract equality): same type → strict; null ≍ undefined;
/// otherwise coerce both to Number and compare.
fn loose_eq(a: &Literal, b: &Literal) -> bool {
    if discriminant(a) == discriminant(b) {
        return strict_eq(a, b);
    }
    match (a, b) {
        (Literal::Null, Literal::Undefined) | (Literal::Undefined, Literal::Null) => true,
        (Literal::Null | Literal::Undefined, _) | (_, Literal::Null | Literal::Undefined) => false,
        _ => {
            let (x, y) = (a.to_number(), b.to_number());
            x == y // NaN compares false, as in JS
        }
    }
}

pub type Env = HashMap<String, Literal>;
pub type SetEnv = HashMap<String, Vec<Literal>>;

fn type_of(node: &Value) -> &str {
    node.get("type").and_then(Value::as_str).unwrap_or("")
}

/// Evaluate an ESTree expression against `env`, returning the proven literal or
/// `None`. Mirrors `evaluate` in eval.ts.
pub fn evaluate(node: &Value, env: &Env) -> Option<Literal> {
    let node = unwrap_ts_assertions(node);
    if !node.is_object() {
        return None;
    }
    match type_of(node) {
        "Literal" => Literal::from_node_value(node.get("value")?),
        "Identifier" => {
            let name = node.get("name").and_then(Value::as_str)?;
            if name == "undefined" {
                return Some(Literal::Undefined);
            }
            env.get(name).cloned()
        }
        "ConditionalExpression" => {
            // `test ? a : b`: sound only when the test is proven — evaluate the
            // taken arm, leaving the other unevaluated so its unknowns cannot
            // poison the result.
            let test = evaluate(node.get("test")?, env)?;
            let arm = if test.to_boolean() { "consequent" } else { "alternate" };
            evaluate(node.get(arm)?, env)
        }
        "UnaryExpression" => {
            let arg = evaluate(node.get("argument")?, env)?;
            match node.get("operator").and_then(Value::as_str)? {
                "!" => Some(Literal::Bool(!arg.to_boolean())),
                "-" => Some(Literal::Num(-arg.to_number())),
                "+" => Some(Literal::Num(arg.to_number())),
                "typeof" => Some(Literal::Str(js_typeof(&arg).to_string())),
                "void" => Some(Literal::Undefined),
                _ => None,
            }
        }
        "LogicalExpression" => {
            let left = evaluate(node.get("left")?, env)?;
            let op = node.get("operator").and_then(Value::as_str)?;
            match op {
                "&&" => {
                    if left.to_boolean() {
                        evaluate(node.get("right")?, env)
                    } else {
                        Some(left)
                    }
                }
                "||" => {
                    if left.to_boolean() {
                        Some(left)
                    } else {
                        evaluate(node.get("right")?, env)
                    }
                }
                "??" => match left {
                    Literal::Null | Literal::Undefined => evaluate(node.get("right")?, env),
                    _ => Some(left),
                },
                _ => None,
            }
        }
        "BinaryExpression" => {
            let l = evaluate(node.get("left")?, env)?;
            let r = evaluate(node.get("right")?, env)?;
            match node.get("operator").and_then(Value::as_str)? {
                "===" => Some(Literal::Bool(strict_eq(&l, &r))),
                "!==" => Some(Literal::Bool(!strict_eq(&l, &r))),
                "==" => Some(Literal::Bool(loose_eq(&l, &r))),
                "!=" => Some(Literal::Bool(!loose_eq(&l, &r))),
                "<" => Some(Literal::Bool(relational(&l, &r, |o| o == std::cmp::Ordering::Less))),
                ">" => Some(Literal::Bool(relational(&l, &r, |o| o == std::cmp::Ordering::Greater))),
                "<=" => Some(Literal::Bool(relational(&l, &r, |o| o != std::cmp::Ordering::Greater))),
                ">=" => Some(Literal::Bool(relational(&l, &r, |o| o != std::cmp::Ordering::Less))),
                "+" => Some(js_add(&l, &r)),
                "-" => Some(Literal::Num(l.to_number() - r.to_number())),
                "*" => Some(Literal::Num(l.to_number() * r.to_number())),
                "/" => Some(Literal::Num(l.to_number() / r.to_number())),
                "%" => Some(Literal::Num(l.to_number() % r.to_number())),
                _ => None,
            }
        }
        _ => None,
    }
}

fn js_typeof(v: &Literal) -> &'static str {
    match v {
        Literal::Str(_) => "string",
        Literal::Num(_) => "number",
        Literal::Bool(_) => "boolean",
        Literal::Null => "object",
        Literal::Undefined => "undefined",
    }
}

/// JS `+`: string concat if either side is a string, else numeric add.
fn js_add(l: &Literal, r: &Literal) -> Literal {
    if matches!(l, Literal::Str(_)) || matches!(r, Literal::Str(_)) {
        Literal::Str(format!("{}{}", l.to_js_string(), r.to_js_string()))
    } else {
        Literal::Num(l.to_number() + r.to_number())
    }
}

/// JS relational (`<`,`>`,`<=`,`>=`): both strings → lexicographic; else numeric
/// with NaN making every comparison false. `want` maps the ordering to the op.
fn relational(l: &Literal, r: &Literal, want: impl Fn(std::cmp::Ordering) -> bool) -> bool {
    if let (Literal::Str(a), Literal::Str(b)) = (l, r) {
        return want(a.cmp(b));
    }
    let (a, b) = (l.to_number(), r.to_number());
    match a.partial_cmp(&b) {
        Some(o) => want(o),
        None => false, // NaN
    }
}

// ---- value-set narrowing (Kleene three-valued) — `None` means "unknown / keep" ----

/// Sound set-aware predicate (`evaluateWithSets`): a known value ONLY when the
/// boolean holds for the whole reachable set.
pub fn evaluate_with_sets(node: &Value, const_env: &Env, set_env: &SetEnv) -> Option<Literal> {
    if let Some(v) = evaluate(node, const_env) {
        return Some(v);
    }
    eval_tri(node, const_env, set_env).map(Literal::Bool)
}

fn eval_tri(node: &Value, const_env: &Env, set_env: &SetEnv) -> Option<bool> {
    let node = unwrap_ts_assertions(node);
    if !node.is_object() {
        return None;
    }
    match type_of(node) {
        "UnaryExpression" => {
            if node.get("operator").and_then(Value::as_str) == Some("!") {
                not_tri(eval_tri(node.get("argument")?, const_env, set_env))
            } else {
                None
            }
        }
        "LogicalExpression" => {
            let op = node.get("operator").and_then(Value::as_str)?;
            let left = eval_tri(node.get("left")?, const_env, set_env);
            if op == "&&" {
                if left == Some(false) {
                    return Some(false);
                }
                return and_tri(left, eval_tri(node.get("right")?, const_env, set_env));
            }
            if op == "||" {
                if left == Some(true) {
                    return Some(true);
                }
                return or_tri(left, eval_tri(node.get("right")?, const_env, set_env));
            }
            None
        }
        "BinaryExpression" => {
            let op = node.get("operator").and_then(Value::as_str)?;
            if matches!(op, "===" | "==" | "!==" | "!=") {
                let loose = op == "==" || op == "!=";
                let eq = equality_tri(node.get("left")?, node.get("right")?, const_env, set_env, loose);
                if op == "!==" || op == "!=" {
                    not_tri(eq)
                } else {
                    eq
                }
            } else {
                None
            }
        }
        _ => None,
    }
}

fn equality_tri(left: &Value, right: &Value, const_env: &Env, set_env: &SetEnv, loose: bool) -> Option<bool> {
    if let (Some(set), Some(lit)) = (set_var(left, set_env), evaluate(right, const_env)) {
        return match_tri(set, &lit, loose);
    }
    if let (Some(set), Some(lit)) = (set_var(right, set_env), evaluate(left, const_env)) {
        return match_tri(set, &lit, loose);
    }
    if let (Some(a), Some(b)) = (evaluate(left, const_env), evaluate(right, const_env)) {
        return Some(if loose { loose_eq(&a, &b) } else { strict_eq(&a, &b) });
    }
    None
}

/// The reachable value set for `node` if it is a bare set-var identifier, else
/// `None`.  Shared with the interprocedural set pass-through (props.rs) so both
/// decide "bare owner-prop reference" identically.  Mirrors `setVar` in eval.ts.
pub(crate) fn set_var<'a>(node: &Value, set_env: &'a SetEnv) -> Option<&'a Vec<Literal>> {
    // A `variant as const` / `variant!` reference is still a bare read of
    // `variant` (the assertion erases at runtime), so it narrows like the
    // identifier it wraps.
    let bare = unwrap_ts_assertions(node);
    if type_of(bare) == "Identifier" {
        if let Some(name) = bare.get("name").and_then(Value::as_str) {
            return set_env.get(name);
        }
    }
    None
}

fn match_tri(set: &[Literal], lit: &Literal, loose: bool) -> Option<bool> {
    let eq = |v: &Literal| if loose { loose_eq(v, lit) } else { strict_eq(v, lit) };
    if !set.iter().any(eq) {
        Some(false) // lit ∉ set
    } else if set.iter().all(eq) {
        Some(true) // set ⊆ {lit}
    } else {
        None // depends on the runtime value
    }
}

fn not_tri(t: Option<bool>) -> Option<bool> {
    t.map(|b| !b)
}
fn and_tri(a: Option<bool>, b: Option<bool>) -> Option<bool> {
    if a == Some(false) || b == Some(false) {
        Some(false)
    } else if a == Some(true) && b == Some(true) {
        Some(true)
    } else {
        None
    }
}
fn or_tri(a: Option<bool>, b: Option<bool>) -> Option<bool> {
    if a == Some(true) || b == Some(true) {
        Some(true)
    } else if a == Some(false) && b == Some(false) {
        Some(false)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn lit_str(v: &str) -> Value {
        json!({ "type": "Literal", "value": v })
    }
    fn ident(name: &str) -> Value {
        json!({ "type": "Identifier", "name": name })
    }
    fn bin(op: &str, l: Value, r: Value) -> Value {
        json!({ "type": "BinaryExpression", "operator": op, "left": l, "right": r })
    }
    fn sets(pairs: &[(&str, &[&str])]) -> SetEnv {
        pairs
            .iter()
            .map(|(k, vs)| (k.to_string(), vs.iter().map(|s| Literal::Str(s.to_string())).collect()))
            .collect()
    }
    fn bool_of(r: Option<Literal>) -> Option<bool> {
        match r {
            Some(Literal::Bool(b)) => Some(b),
            _ => None,
        }
    }

    #[test]
    fn strict_eq_false_when_not_in_set() {
        let variant = sets(&[("variant", &["primary", "secondary"])]);
        let e = bin("===", ident("variant"), lit_str("danger"));
        assert_eq!(bool_of(evaluate_with_sets(&e, &Env::new(), &variant)), Some(false));
        let loose = bin("==", ident("variant"), lit_str("danger"));
        assert_eq!(bool_of(evaluate_with_sets(&loose, &Env::new(), &variant)), Some(false));
    }

    #[test]
    fn unknown_when_one_of_several() {
        let variant = sets(&[("variant", &["primary", "secondary"])]);
        assert_eq!(
            evaluate_with_sets(&bin("===", ident("variant"), lit_str("primary")), &Env::new(), &variant),
            None
        );
    }

    #[test]
    fn true_only_for_singleton_set() {
        let single = sets(&[("v", &["only"])]);
        assert_eq!(
            bool_of(evaluate_with_sets(&bin("===", ident("v"), lit_str("only")), &Env::new(), &single)),
            Some(true)
        );
    }

    #[test]
    fn neq_negates() {
        let variant = sets(&[("variant", &["primary", "secondary"])]);
        assert_eq!(
            bool_of(evaluate_with_sets(&bin("!==", ident("variant"), lit_str("danger")), &Env::new(), &variant)),
            Some(true)
        );
        assert_eq!(
            evaluate_with_sets(&bin("!==", ident("variant"), lit_str("primary")), &Env::new(), &variant),
            None
        );
    }

    #[test]
    fn kleene_combinations() {
        let variant = sets(&[("variant", &["primary", "secondary"])]);
        let empty = Env::new();
        // false && unknown -> false
        let a = json!({ "type": "LogicalExpression", "operator": "&&",
            "left": bin("===", ident("variant"), lit_str("danger")),
            "right": bin("===", ident("variant"), lit_str("primary")) });
        assert_eq!(bool_of(evaluate_with_sets(&a, &empty, &variant)), Some(false));
        // true || unknown -> true
        let b = json!({ "type": "LogicalExpression", "operator": "||",
            "left": bin("!==", ident("variant"), lit_str("danger")),
            "right": bin("===", ident("variant"), lit_str("primary")) });
        assert_eq!(bool_of(evaluate_with_sets(&b, &empty, &variant)), Some(true));
        // !(provably false) -> true
        let c = json!({ "type": "UnaryExpression", "operator": "!",
            "argument": bin("===", ident("variant"), lit_str("danger")) });
        assert_eq!(bool_of(evaluate_with_sets(&c, &empty, &variant)), Some(true));
        // unknown || unknown -> unknown
        let d = json!({ "type": "LogicalExpression", "operator": "||",
            "left": bin("===", ident("variant"), lit_str("primary")),
            "right": bin("===", ident("variant"), lit_str("secondary")) });
        assert_eq!(evaluate_with_sets(&d, &empty, &variant), None);
    }

    #[test]
    fn folds_pure_constants_and_const_props() {
        let variant = sets(&[("variant", &["primary", "secondary"])]);
        // 1 + 1 === 2
        let e = bin(
            "===",
            bin("+", json!({"type":"Literal","value":1}), json!({"type":"Literal","value":1})),
            json!({"type":"Literal","value":2}),
        );
        assert_eq!(bool_of(evaluate_with_sets(&e, &Env::new(), &variant)), Some(true));
        // size === 'lg' with size:'lg' in constEnv
        let mut env = Env::new();
        env.insert("size".into(), Literal::Str("lg".into()));
        assert_eq!(
            bool_of(evaluate_with_sets(&bin("===", ident("size"), lit_str("lg")), &env, &variant)),
            Some(true)
        );
    }

    #[test]
    fn no_guess_on_ordering_or_arith_over_sets() {
        let nums: SetEnv = [("n".to_string(), vec![Literal::Num(1.0), Literal::Num(2.0)])].into_iter().collect();
        let gt = bin(">", ident("n"), json!({"type":"Literal","value":0}));
        assert_eq!(evaluate_with_sets(&gt, &Env::new(), &nums), None);
        let arith = bin(
            "===",
            bin("+", ident("n"), json!({"type":"Literal","value":1})),
            json!({"type":"Literal","value":2}),
        );
        assert_eq!(evaluate_with_sets(&arith, &Env::new(), &nums), None);
    }

    fn ts_as(inner: Value) -> Value {
        json!({ "type": "TSAsExpression", "expression": inner })
    }
    fn ts_non_null(inner: Value) -> Value {
        json!({ "type": "TSNonNullExpression", "expression": inner })
    }

    #[test]
    fn evaluate_reads_through_ts_assertions() {
        // `'chips' as const` folds to the literal (issue #150).
        assert_eq!(evaluate(&ts_as(lit_str("chips")), &Env::new()), Some(Literal::Str("chips".into())));
        // `x!` folds through the env.
        let mut env = Env::new();
        env.insert("x".into(), Literal::Num(7.0));
        assert_eq!(evaluate(&ts_non_null(ident("x")), &env), Some(Literal::Num(7.0)));
        // Nested `('a' as const)!` peels both layers.
        assert_eq!(
            evaluate(&ts_non_null(ts_as(lit_str("a"))), &Env::new()),
            Some(Literal::Str("a".into()))
        );
        // A non-constant identifier under an assertion stays unknown.
        assert_eq!(evaluate(&ts_as(ident("dynamic")), &Env::new()), None);
    }

    #[test]
    fn set_var_reads_through_ts_assertions() {
        let variant = sets(&[("variant", &["primary", "secondary"])]);
        // `(variant as const) === 'danger'` narrows like the bare `variant`.
        let e = bin("===", ts_as(ident("variant")), lit_str("danger"));
        assert_eq!(bool_of(evaluate_with_sets(&e, &Env::new(), &variant)), Some(false));
    }

    #[test]
    fn loose_equality_coercion() {
        assert!(loose_eq(&Literal::Str("1".into()), &Literal::Num(1.0)));
        assert!(loose_eq(&Literal::Str("".into()), &Literal::Num(0.0)));
        assert!(loose_eq(&Literal::Null, &Literal::Undefined));
        assert!(!loose_eq(&Literal::Null, &Literal::Num(0.0)));
        assert!(!loose_eq(&Literal::Str("a".into()), &Literal::Num(0.0)));
        assert!(loose_eq(&Literal::Bool(true), &Literal::Num(1.0)));
    }
}
