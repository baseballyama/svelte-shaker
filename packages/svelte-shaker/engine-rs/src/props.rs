//! Props/call-site model: prop declarations with defaults, call-site reading
//! (last-write-wins + spread tracking), and per-prop value-set joining.

use serde_json::Value;
use std::collections::{HashMap, HashSet};

use crate::ast::*;
use crate::eval::{evaluate, set_var, Env, Literal, SetEnv};

/// `SameValue` dedup (JS `Object.is`): NaN == NaN, +0 != -0.
pub(crate) fn object_is(a: &Literal, b: &Literal) -> bool {
    match (a, b) {
        (Literal::Num(x), Literal::Num(y)) => {
            if x.is_nan() && y.is_nan() {
                true
            } else {
                x.to_bits() == y.to_bits()
            }
        }
        _ => a == b,
    }
}

pub(crate) fn push_literal_unique(values: &mut Vec<Literal>, v: Literal) {
    if !values.iter().any(|x| object_is(x, &v)) {
        values.push(v);
    }
}

// ---- prop declarations with defaults --------------------------------------

pub(crate) struct PropDecl {
    /// The EXTERNAL prop name — the destructure KEY (`prop` in `prop: alias`).
    /// Call sites pass this name, so value sets / dropping key off it.  Mirrors
    /// `PropDecl.name` in analyze.ts.
    pub(crate) name: String,
    /// The LOCAL binding name the entry introduces in the body — the destructure
    /// VALUE (`alias` in `prop: alias`, or the bare name for a shorthand `prop`),
    /// or `None` when the entry binds a NESTED pattern (`prop: { x }`) rather than
    /// a single identifier.  Body and template references use THIS name, not
    /// {@link name} (`prop` and its alias `alias` can even be different entities —
    /// e.g. a same-named import), so folding/substitution must look props up by it.
    /// A `None` local is never foldable.  Mirrors `PropDecl.local` in analyze.ts.
    pub(crate) local: Option<String>,
    /// The default-value expression node, or `Null` when omitted.
    pub(crate) default: Value,
    /// The `Property` node inside the `ObjectPattern` (for surgical removal).
    pub(crate) property: Value,
}

/// The `$props()` destructuring of a component, when present.
pub(crate) struct PropsInfo {
    pub(crate) props: Vec<PropDecl>,
    pub(crate) has_rest: bool,
    /// `$props()` is not the sole declarator of its statement (a conservative bail).
    pub(crate) shares_statement: bool,
    /// The `ObjectPattern` (for editing) and the whole `VariableDeclaration`.
    pub(crate) pattern: Value,
    pub(crate) declaration: Value,
}

/// `findPropsDeclaration` + the prop loop. `None` when the component has no
/// `$props()` destructuring.
pub(crate) fn declared_props_full(ast: &Value) -> Option<PropsInfo> {
    let body = ast
        .get("instance")
        .and_then(|i| i.get("content"))
        .and_then(|c| c.get("body"))
        .and_then(Value::as_array)?;
    for stmt in body {
        if !str_eq(stmt, "type", "VariableDeclaration") {
            continue;
        }
        let decls = arr(stmt, "declarations");
        for decl in decls {
            let init = get(decl, "init");
            let id = get(decl, "id");
            let is_props_call = str_eq(init, "type", "CallExpression")
                && str_eq(get(init, "callee"), "type", "Identifier")
                && str_eq(get(init, "callee"), "name", "$props");
            if !is_props_call || !str_eq(id, "type", "ObjectPattern") {
                continue;
            }
            let mut props = Vec::new();
            let mut has_rest = false;
            for p in arr(id, "properties") {
                match type_of(p) {
                    Some("RestElement") => has_rest = true,
                    Some("Property") => {
                        let key = get(p, "key");
                        if str_eq(key, "type", "Identifier") {
                            if let Some(name) = key.get("name").and_then(Value::as_str) {
                                // The destructure VALUE is the local binding.  A bare identifier
                                // (`prop` shorthand, or `prop: alias`) binds that one name; an
                                // `AssignmentPattern` (`prop = d` / `prop: alias = d`) binds its
                                // LEFT and carries the default; anything else (a nested
                                // Object/Array pattern) binds no single identifier, so `local` is
                                // `None` and the prop is never foldable.  Mirrors analyze.ts.
                                let value = get(p, "value");
                                let mut local: Option<String> = None;
                                let mut default = Value::Null;
                                match type_of(value) {
                                    Some("Identifier") => {
                                        local = value.get("name").and_then(Value::as_str).map(str::to_string);
                                    }
                                    Some("AssignmentPattern") => {
                                        default = get(value, "right").clone();
                                        let left = get(value, "left");
                                        if str_eq(left, "type", "Identifier") {
                                            local = left.get("name").and_then(Value::as_str).map(str::to_string);
                                        }
                                    }
                                    _ => {}
                                }
                                props.push(PropDecl { name: name.to_string(), local, default, property: p.clone() });
                            }
                        }
                    }
                    _ => {}
                }
            }
            return Some(PropsInfo {
                props,
                has_rest,
                shares_statement: decls.len() > 1,
                pattern: id.clone(),
                declaration: stmt.clone(),
            });
        }
    }
    None
}

// ---- reachable input set (reverse analysis, docs §PR4) ---------------------

/// The inputs a component can OBSERVE at runtime.  In runes there is no
/// `$$props`, so a component reads an input only through its `$props()`
/// destructure — mirrors `ReachableInputs` in analyze.ts.
pub(crate) enum ReachableInputs {
    /// Any input might be observed (a `...rest`, a non-ObjectPattern binding,
    /// more than one `$props()` call, or `$props()` outside a declarator).
    All,
    /// Exactly these declared external names (a clean rest-free ObjectPattern
    /// `$props()`, or the empty set when there is no `$props()` at all).
    Names(HashSet<String>),
}

/// Derive {@link ReachableInputs} from the `$props()` shape (mirrors
/// `computeReachableInputs`).  `props_info` is the clean-ObjectPattern match from
/// {@link declared_props_full}; a second call, a non-ObjectPattern binding, or a
/// rest falls back to `All`.  `$props.id()` (a member call) is not a `$props()`
/// call, so it does not count.
pub(crate) fn compute_reachable_inputs(ast: &Value, props_info: &Option<PropsInfo>) -> ReachableInputs {
    let calls = count_props_calls(get(ast, "instance"));
    if calls == 0 {
        return ReachableInputs::Names(HashSet::new()); // no `$props()` -> reads nothing
    }
    match props_info {
        // Any property whose external name we could not statically capture (a
        // string-literal key `{ 'aria-label': label }` or a computed key `{ [k]: v }`)
        // is a prop the child DOES read but that is absent from `props`, so its
        // call-site attribute would be wrongly droppable -> fall back to ALL.
        Some(pi) if calls == 1 && !pi.has_rest && !has_unrepresentable_key(&pi.pattern) => {
            ReachableInputs::Names(pi.props.iter().map(|p| p.name.clone()).collect())
        }
        _ => ReachableInputs::All,
    }
}

/// True when a `$props()` ObjectPattern binds a prop whose external name is not a
/// plain identifier (a string-literal or computed key), so {@link declared_props_full}
/// did not capture it.
fn has_unrepresentable_key(pattern: &Value) -> bool {
    for p in arr(pattern, "properties") {
        match type_of(p) {
            Some("RestElement") => continue, // handled via has_rest
            Some("Property") => {
                if bool_field(p, "computed") || type_of(get(p, "key")) != Some("Identifier") {
                    return true;
                }
            }
            _ => return true, // unexpected shape -> conservative ALL
        }
    }
    false
}

pub(crate) fn count_props_calls(instance: &Value) -> usize {
    let mut count = 0;
    walk(instance, &mut |node| {
        if str_eq(node, "type", "CallExpression")
            && str_eq(get(node, "callee"), "type", "Identifier")
            && str_eq(get(node, "callee"), "name", "$props")
        {
            count += 1;
        }
    });
    count
}

// ---- call-site reading -----------------------------------------------------

pub(crate) struct ExplicitProp {
    pub(crate) value: Option<Literal>, // None when `dynamic`
    pub(crate) dynamic: bool,
    pub(crate) after_last_spread: bool,
    /// For a `dynamic` write whose value is a single expression (`prop={expr}`, or
    /// a known-spread key `{...{prop: expr}}`), the raw expression node — kept so
    /// the fixpoint can fold it against the OWNING component's env (interprocedural
    /// pass-through, docs §13.1). `Null` for a literal write, a `bind:` (never
    /// folded), or a multi-part value. Mirrors `ExplicitProp.expr` in analyze.ts.
    pub(crate) expr: Value,
}

pub(crate) struct CallSite {
    pub(crate) had_spread: bool,
    pub(crate) explicit: HashMap<String, ExplicitProp>,
    /// The component that OWNS this call site (renders the `<Child .../>`); the
    /// fixpoint evaluates a forwarded expression against its fold env. `None` for
    /// callers outside the graph fixpoint (mono). Mirrors `CallSite.owner`.
    pub(crate) owner: Option<String>,
}

pub(crate) fn dynamic_write(index: i64, last_spread: i64, expr: Value) -> ExplicitProp {
    ExplicitProp { value: None, dynamic: true, after_last_spread: index > last_spread, expr }
}

/// Read a literal off an attribute `value` (true | node | node[]); `None` => not
/// statically known. Mirrors `literalAttrValue`.
pub(crate) fn literal_attr_value(value: &Value) -> Option<Literal> {
    if value == &Value::Bool(true) {
        return Some(Literal::Bool(true)); // boolean shorthand
    }
    if value.is_null() {
        return None;
    }
    let single;
    let parts: &[Value] = match value.as_array() {
        Some(a) => a,
        None => {
            single = [value.clone()];
            &single
        }
    };
    if parts.len() == 1 {
        let part = &parts[0];
        if type_of(part) == Some("Text") {
            return Some(Literal::Str(text_data(part)));
        }
        if type_of(part) == Some("ExpressionTag") {
            // Recognize `prop={'x' as const}` as the literal it wraps, so the write
            // is classified NON-dynamic identically to a parser that strips the
            // assertion — mono's `specializable_shape` reads the `dynamic` flag.
            let expr = unwrap_ts_assertions(get(part, "expression"));
            if str_eq(expr, "type", "Literal") {
                return Literal::from_node_value(expr.get("value")?);
            }
        }
        return None;
    }
    // Multiple parts: fold only when every part is static text.
    let mut text = String::new();
    for part in parts {
        if type_of(part) != Some("Text") {
            return None;
        }
        text.push_str(&text_data(part));
    }
    Some(Literal::Str(text))
}

pub(crate) fn text_data(node: &Value) -> String {
    node.get("data")
        .or_else(|| node.get("raw"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// Props supplied through a `<Child>…</Child>` body: `children` for any
/// renderable content + one per named `{#snippet}`. Mirrors `synthesizedBodyProps`.
pub(crate) fn synthesized_body_props(component: &Value) -> Vec<String> {
    let nodes = get(component, "fragment").get("nodes").and_then(Value::as_array);
    let nodes = match nodes {
        Some(n) => n,
        None => return Vec::new(),
    };
    let mut names = Vec::new();
    let mut has_children = false;
    for node in nodes {
        match type_of(node) {
            Some("SnippetBlock") => {
                let expr = get(node, "expression");
                if str_eq(expr, "type", "Identifier") {
                    if let Some(n) = expr.get("name").and_then(Value::as_str) {
                        names.push(n.to_string());
                    }
                }
            }
            Some("Comment") => {}
            Some("Text") => {
                if !text_data(node).trim().is_empty() {
                    has_children = true;
                }
            }
            _ => has_children = true,
        }
    }
    if has_children {
        names.push("children".to_string());
    }
    names
}

/// The `(name, value, expr)` entries a statically-known object-literal spread
/// contributes: `value` is `Some(lit)` for a literal (so it folds) or `None` for a
/// non-literal value (key known, value dynamic) whose node is carried in `expr`.
pub(crate) type SpreadEntries = Vec<(String, Option<Literal>, Value)>;

/// The `[name, value, expr]` entries a spread contributes IF it is a
/// statically-known object literal whose complete key set we can see. `None` =>
/// an opaque spread (an identifier/call `{...rest}`, or an object literal carrying
/// a nested spread, a computed key, or a getter/setter/method) that may set any
/// prop. Each value is `Some(lit)` for a literal (so it folds) or `None` for a
/// non-literal value (key known, value dynamic) — in which case `expr` carries the
/// value node so the fixpoint can retry it against the owner env. Mirrors
/// `knownSpreadEntries` in analyze.ts.
pub(crate) fn known_spread_entries(attr: &Value) -> Option<SpreadEntries> {
    let obj = get(attr, "expression");
    if type_of(obj) != Some("ObjectExpression") {
        return None;
    }
    let empty: Env = HashMap::new();
    let mut entries = Vec::new();
    for prop in arr(obj, "properties") {
        // A nested spread, computed key, or accessor/method means the full key set
        // is not statically knowable -> the whole spread is opaque.
        if type_of(prop) != Some("Property") {
            return None;
        }
        if bool_field(prop, "computed")
            || str_eq(prop, "kind", "get")
            || str_eq(prop, "kind", "set")
            || bool_field(prop, "method")
        {
            return None;
        }
        let key = get(prop, "key");
        let name = match type_of(key) {
            Some("Identifier") => key.get("name").and_then(Value::as_str).map(str::to_string),
            Some("Literal") => match key.get("value") {
                Some(Value::String(s)) => Some(s.clone()),
                Some(Value::Number(n)) => Some(n.to_string()),
                _ => None,
            },
            _ => None,
        };
        let name = name?; // unknown key shape -> whole spread opaque
        let val_node = get(prop, "value");
        let lit = evaluate(val_node, &empty);
        let expr = if lit.is_none() { val_node.clone() } else { Value::Null };
        entries.push((name, lit, expr));
    }
    Some(entries)
}

/// The single expression node behind a non-literal attribute value
/// (`prop={expr}`), or `Null` when the value is a boolean shorthand, plain text,
/// or a multi-part concatenation. Mirrors `singleExprValue` in analyze.ts.
fn single_expr_value(value: &Value) -> Value {
    if value == &Value::Bool(true) || value.is_null() {
        return Value::Null;
    }
    let single;
    let parts: &[Value] = match value.as_array() {
        Some(a) => a,
        None => {
            single = [value.clone()];
            &single
        }
    };
    if parts.len() == 1 && type_of(&parts[0]) == Some("ExpressionTag") {
        return get(&parts[0], "expression").clone();
    }
    Value::Null
}

/// Read one `<Child .../>` into a {@link CallSite} (last-write-wins + spread
/// tracking + synthesized body props). Mirrors `readCallSite`.
pub(crate) fn read_call_site(component: &Value, owner: Option<String>) -> CallSite {
    let attrs = arr(component, "attributes");
    // Only spreads we cannot expand are opaque; a known object literal is expanded
    // into explicit writes below, so `after_last_spread` is measured against the
    // last *unknown* spread (mirrors readCallSite). Evaluating a spread clones every
    // non-literal value node, so cache each spread's result on the first pass and
    // reuse it below rather than evaluating it a second time.
    let mut spread_entries: HashMap<usize, Option<SpreadEntries>> = HashMap::new();
    let mut last_spread: i64 = -1;
    for (i, a) in attrs.iter().enumerate() {
        if type_of(a) == Some("SpreadAttribute") {
            let entries = known_spread_entries(a);
            if entries.is_none() {
                last_spread = i as i64;
            }
            spread_entries.insert(i, entries);
        }
    }
    let mut explicit: HashMap<String, ExplicitProp> = HashMap::new();
    for (pos, attr) in attrs.iter().enumerate() {
        let i = pos as i64;
        if type_of(attr) == Some("SpreadAttribute") {
            // A known object-literal spread expands to one explicit write per key;
            // an unknown spread is opaque (handled via had_spread/after_last_spread).
            if let Some(Some(entries)) = spread_entries.remove(&pos) {
                for (name, val, expr) in entries {
                    let prop = match val {
                        Some(v) => ExplicitProp {
                            value: Some(v),
                            dynamic: false,
                            after_last_spread: i > last_spread,
                            expr: Value::Null,
                        },
                        None => dynamic_write(i, last_spread, expr),
                    };
                    explicit.insert(name, prop);
                }
            }
            continue;
        }
        let name = attr.get("name").and_then(Value::as_str);
        if type_of(attr) == Some("BindDirective") {
            // A `bind:` is a two-way write that must never fold — no `expr`.
            if let Some(n) = name {
                explicit.insert(n.to_string(), dynamic_write(i, last_spread, Value::Null));
            }
            continue;
        }
        if type_of(attr) != Some("Attribute") {
            continue;
        }
        let name = match name {
            Some(n) => n,
            None => continue,
        };
        let value = get(attr, "value");
        match literal_attr_value(value) {
            Some(v) => {
                explicit.insert(
                    name.to_string(),
                    ExplicitProp {
                        value: Some(v),
                        dynamic: false,
                        after_last_spread: i > last_spread,
                        expr: Value::Null,
                    },
                );
            }
            None => {
                explicit.insert(name.to_string(), dynamic_write(i, last_spread, single_expr_value(value)));
            }
        }
    }
    for name in synthesized_body_props(component) {
        explicit.insert(name, dynamic_write(attrs.len() as i64, last_spread, Value::Null));
    }
    CallSite { had_spread: last_spread >= 0, explicit, owner }
}

// ---- value-set join --------------------------------------------------------

pub(crate) struct PropValueSet {
    pub(crate) values: Vec<Literal>,
    pub(crate) dynamic: bool,
    pub(crate) top: bool,
}

pub(crate) fn literal_default(expr: &Value) -> Option<Literal> {
    // A default like `= 500 as const` arrives as a `TSAsExpression`; the assertion
    // erases at runtime, so read through it to the bare default value.
    let expr = unwrap_ts_assertions(expr);
    if expr.is_null() {
        return Some(Literal::Undefined); // omitted default -> undefined
    }
    match type_of(expr) {
        Some("Literal") => Literal::from_node_value(expr.get("value")?),
        Some("Identifier") if expr.get("name").and_then(Value::as_str) == Some("undefined") => {
            Some(Literal::Undefined)
        }
        _ => None,
    }
}

/// The OWNER component's forwardable knowledge, both local-keyed: `fold` collapses
/// a prop to one literal (constFold), `narrow` holds a prop's known reachable set
/// (narrow). A forwarded bare owner-prop reference can propagate either — the
/// single value or the whole set (docs §13.1). Mirrors `OwnerFoldEnv` in analyze.ts.
pub(crate) struct OwnerEnv {
    pub(crate) fold: Env,
    pub(crate) narrow: SetEnv,
}

/// Per-owner {@link OwnerEnv} for this fixpoint round (the previous round's folds).
pub(crate) type OwnerEnvs = HashMap<String, OwnerEnv>;

pub(crate) fn value_set_for(decl: &PropDecl, sites: &[CallSite], owner_envs: &OwnerEnvs) -> PropValueSet {
    let empty_fold: Env = HashMap::new();
    let empty_narrow: SetEnv = HashMap::new();
    let mut values = Vec::new();
    let mut dynamic = false;
    let mut top = false;
    for site in sites {
        match site.explicit.get(&decl.name) {
            Some(e) if e.after_last_spread => {
                if !e.dynamic {
                    if let Some(v) = &e.value {
                        push_literal_unique(&mut values, v.clone());
                    }
                } else {
                    // Interprocedural pass-through: resolve the forwarded expression
                    // against the OWNER's env (previous round). A `bind:`/multi-part
                    // write has no `expr`, so it never resolves here.
                    let owner_env = site.owner.as_ref().and_then(|o| owner_envs.get(o));
                    let fold = owner_env.map(|e| &e.fold).unwrap_or(&empty_fold);
                    let narrow = owner_env.map(|e| &e.narrow).unwrap_or(&empty_narrow);
                    // A BARE owner-prop reference the owner narrowed to a known set
                    // contributes that whole set (mirrors css.rs's bare set-var path).
                    // Sound: the owner keeps the narrowed prop genuinely used, so the
                    // residual owner passes each member as-is; the child receives a
                    // subset. constFold/narrow never share a name, so lookup order is
                    // immaterial. Otherwise: a `known` fold => a value this site
                    // provably passes; anything else stays dynamic.
                    let set = if e.expr.is_null() { None } else { set_var(&e.expr, narrow) };
                    if let Some(vs) = set {
                        for v in vs {
                            push_literal_unique(&mut values, v.clone());
                        }
                    } else {
                        match if e.expr.is_null() { None } else { evaluate(&e.expr, fold) } {
                            Some(v) => push_literal_unique(&mut values, v),
                            None => dynamic = true,
                        }
                    }
                }
            }
            _ => {
                if site.had_spread {
                    top = true; // a spread may set it -> Unknown
                } else {
                    match literal_default(&decl.default) {
                        Some(v) => push_literal_unique(&mut values, v),
                        None => dynamic = true,
                    }
                }
            }
        }
    }
    PropValueSet { values, dynamic, top }
}

#[cfg(test)]
mod tests {
    use super::*;

    // `push_literal_unique` must dedupe by JS `Object.is` (SameValue), the same
    // rule analyze.ts's `add` uses — so the two engines build byte-identical value
    // sets. The tricky cases are the numeric ones: -0 and +0 are DISTINCT values
    // that must both survive, while two NaNs are the SAME value and collapse. This
    // pins the pass-through set dedupe (props.rs `value_set_for`) matches TS.
    #[test]
    fn dedupe_keeps_signed_zero_distinct_and_collapses_nan() {
        let mut values: Vec<Literal> = Vec::new();
        push_literal_unique(&mut values, Literal::Num(-0.0));
        push_literal_unique(&mut values, Literal::Num(0.0));
        push_literal_unique(&mut values, Literal::Num(f64::NAN));
        push_literal_unique(&mut values, Literal::Num(f64::NAN)); // dup NaN -> dropped
        push_literal_unique(&mut values, Literal::Num(-0.0)); // dup -0 -> dropped

        assert_eq!(values.len(), 3);
        // Order-stable, and -0 kept separate from +0 (bit pattern, like `Object.is`).
        assert!(matches!(values[0], Literal::Num(z) if z == 0.0 && z.is_sign_negative()));
        assert!(matches!(values[1], Literal::Num(z) if z == 0.0 && z.is_sign_positive()));
        assert!(matches!(values[2], Literal::Num(n) if n.is_nan()));
    }
}
