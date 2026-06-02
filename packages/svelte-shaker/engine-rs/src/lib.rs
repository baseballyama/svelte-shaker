//! WASM core for svelte-shaker (docs/RUST-MIGRATION.md M4+).
//!
//! Self-contained on purpose: it analyzes a Svelte component AST handed in as
//! JSON (the modern parse shape — produced on the JS side by rsvelte or
//! svelte/compiler), so it has NO build dependency on the rsvelte compiler crate
//! and builds to a small, cross-platform `wasm` artifact. It is being ported one
//! validated slice at a time, each pinned against the TS engine by a differential
//! test (`packages/svelte-shaker/tests/wasm-m4.test.ts`).

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use wasm_bindgen::prelude::*;

mod eval;
mod transform;
use eval::{evaluate, evaluate_with_sets, Env, Literal, SetEnv};
use transform::MagicEdit;

const NULL: Value = Value::Null;

/// `node[key] === val` for a string field, false if absent or non-string.
fn str_eq(node: &Value, key: &str, val: &str) -> bool {
    node.get(key).and_then(Value::as_str) == Some(val)
}

fn type_of(node: &Value) -> Option<&str> {
    node.get("type").and_then(Value::as_str)
}

fn get<'a>(node: &'a Value, key: &str) -> &'a Value {
    node.get(key).unwrap_or(&NULL)
}

fn arr<'a>(node: &'a Value, key: &str) -> &'a [Value] {
    node.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

fn push_unique(out: &mut Vec<String>, name: &str) {
    if !out.iter().any(|x| x == name) {
        out.push(name.to_string());
    }
}

/// Visit every object node in `root` (depth-first), calling `f` on each. The
/// analog of a zimmerframe walk whose visitor descends unconditionally.
fn walk(root: &Value, f: &mut impl FnMut(&Value)) {
    match root {
        Value::Object(map) => {
            f(root);
            for v in map.values() {
                walk(v, f);
            }
        }
        Value::Array(items) => {
            for v in items {
                walk(v, f);
            }
        }
        _ => {}
    }
}

/// The declared prop names (the `Property` keys of the `let { ... } = $props()`
/// `ObjectPattern`, a `...rest` skipped) plus whether such a rest element exists
/// — mirrors `findPropsDeclaration` + the prop loop in analyze.ts.
fn declared_props(ast: &Value) -> (Vec<String>, bool) {
    let body = match ast
        .get("instance")
        .and_then(|i| i.get("content"))
        .and_then(|c| c.get("body"))
        .and_then(Value::as_array)
    {
        Some(b) => b,
        None => return (Vec::new(), false),
    };

    for stmt in body {
        if !str_eq(stmt, "type", "VariableDeclaration") {
            continue;
        }
        for decl in arr(stmt, "declarations") {
            let init = get(decl, "init");
            let id = get(decl, "id");
            let is_props_call = str_eq(init, "type", "CallExpression")
                && str_eq(get(init, "callee"), "type", "Identifier")
                && str_eq(get(init, "callee"), "name", "$props");
            if !is_props_call || !str_eq(id, "type", "ObjectPattern") {
                continue;
            }
            let mut names = Vec::new();
            let mut has_rest = false;
            for p in arr(id, "properties") {
                match type_of(p) {
                    // `...rest` holds only UNDECLARED props — not a declared name.
                    Some("RestElement") => has_rest = true,
                    Some("Property") => {
                        let key = get(p, "key");
                        if str_eq(key, "type", "Identifier") {
                            if let Some(name) = key.get("name").and_then(Value::as_str) {
                                names.push(name.to_string());
                            }
                        }
                    }
                    _ => {}
                }
            }
            return (names, has_rest); // the first `$props()` destructuring wins
        }
    }
    (Vec::new(), false)
}

/// Add every identifier bound by a (possibly destructuring) pattern — bare
/// identifiers, object/array destructuring, defaults and rest. Mirrors
/// `addPatternNames` in analyze.ts.
fn add_pattern_names(pat: &Value, out: &mut Vec<String>) {
    match type_of(pat) {
        Some("Identifier") => {
            if let Some(n) = pat.get("name").and_then(Value::as_str) {
                push_unique(out, n);
            }
        }
        Some("ObjectPattern") => {
            for p in arr(pat, "properties") {
                match type_of(p) {
                    Some("RestElement") => add_pattern_names(get(p, "argument"), out),
                    // `{ a }` / `{ a: b }` — the binding is the property *value*
                    // (falling back to the key for shorthand without an explicit value).
                    Some("Property") => {
                        let value = p.get("value").filter(|v| !v.is_null());
                        add_pattern_names(value.unwrap_or_else(|| get(p, "key")), out);
                    }
                    _ => {}
                }
            }
        }
        Some("ArrayPattern") => {
            for el in arr(pat, "elements") {
                add_pattern_names(el, out);
            }
        }
        Some("AssignmentPattern") => add_pattern_names(get(pat, "left"), out),
        Some("RestElement") => add_pattern_names(get(pat, "argument"), out),
        _ => {}
    }
}

/// Names bound OUTSIDE the `$props()` pattern (a same-named prop is a different
/// entity there, so it must never be folded) and names used as `{@debug}`
/// arguments. Mirrors `collectTemplateBindings` in analyze.ts. The `$props()`
/// destructuring binds via an `ObjectPattern`, never an `Identifier`/function
/// param, so it is naturally excluded by the branches below.
fn template_bindings(ast: &Value) -> (Vec<String>, Vec<String>) {
    let mut shadowed = Vec::new();
    let mut debug = Vec::new();

    // Instance-script `let` / `function` declarations and function parameters.
    walk(get(ast, "instance"), &mut |node| {
        match type_of(node) {
            Some("VariableDeclarator") | Some("FunctionDeclaration") => {
                let id = get(node, "id");
                if str_eq(id, "type", "Identifier") {
                    if let Some(n) = id.get("name").and_then(Value::as_str) {
                        push_unique(&mut shadowed, n);
                    }
                }
            }
            _ => {}
        }
        if matches!(
            type_of(node),
            Some("FunctionDeclaration") | Some("FunctionExpression") | Some("ArrowFunctionExpression")
        ) {
            for param in arr(node, "params") {
                add_pattern_names(param, &mut shadowed);
            }
        }
    });

    // Template-scope binders + `{@debug}` arguments.
    walk(get(ast, "fragment"), &mut |node| match type_of(node) {
        Some("EachBlock") => {
            add_pattern_names(get(node, "context"), &mut shadowed);
            if let Some(i) = node.get("index").and_then(Value::as_str) {
                push_unique(&mut shadowed, i);
            }
        }
        Some("SnippetBlock") => {
            let expr = get(node, "expression");
            if str_eq(expr, "type", "Identifier") {
                if let Some(n) = expr.get("name").and_then(Value::as_str) {
                    push_unique(&mut shadowed, n);
                }
            }
            for p in arr(node, "parameters") {
                add_pattern_names(p, &mut shadowed);
            }
        }
        Some("AwaitBlock") => {
            add_pattern_names(get(node, "value"), &mut shadowed);
            add_pattern_names(get(node, "error"), &mut shadowed);
        }
        Some("LetDirective") => {
            if let Some(n) = node.get("name").and_then(Value::as_str) {
                push_unique(&mut shadowed, n);
            }
        }
        Some("ConstTag") => {
            for d in arr(get(node, "declaration"), "declarations") {
                add_pattern_names(get(d, "id"), &mut shadowed);
            }
        }
        Some("DebugTag") => {
            for ident in arr(node, "identifiers") {
                if str_eq(ident, "type", "Identifier") {
                    if let Some(n) = ident.get("name").and_then(Value::as_str) {
                        push_unique(&mut debug, n);
                    }
                }
            }
        }
        _ => {}
    });

    (shadowed, debug)
}

/// Whole-component bail reasons: `<svelte:options accessors|customElement>` makes
/// props externally settable, so the component is left untouched (analyze.ts §4.1).
fn component_bail(ast: &Value) -> Vec<String> {
    let mut reasons = Vec::new();
    walk(ast, &mut |node| {
        if str_eq(node, "type", "SvelteOptions") {
            for a in arr(node, "attributes") {
                if str_eq(a, "type", "Attribute") {
                    if let Some(name) = a.get("name").and_then(Value::as_str) {
                        if name == "accessors" || name == "customElement" {
                            reasons.push(format!("<svelte:options {name}>"));
                        }
                    }
                }
            }
        }
    });
    reasons
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v.dedup();
    v
}

/// Visit every object node depth-first WITH its nearest object parent (arrays are
/// transparent — an element's parent is the object owning the array), mirroring
/// zimmerframe's `state.parent`.
fn walk_parented<'a, F: FnMut(&Value, Option<&Value>)>(
    node: &'a Value,
    parent: Option<&'a Value>,
    f: &mut F,
) {
    match node {
        Value::Object(map) => {
            f(node, parent);
            for v in map.values() {
                walk_parented(v, Some(node), f);
            }
        }
        Value::Array(items) => {
            for v in items {
                walk_parented(v, parent, f);
            }
        }
        _ => {}
    }
}

fn bool_field(node: &Value, key: &str) -> bool {
    node.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// Two AST nodes are the same node iff their source spans coincide — a reliable
/// identity proxy (no two nodes share a `start`), used in place of the JS `===`.
fn same_node(a: &Value, b: &Value) -> bool {
    a.get("start").is_some() && a.get("start") == b.get("start") && a.get("end") == b.get("end")
}

fn is_import_specifier_position(parent: &Value) -> bool {
    matches!(
        type_of(parent),
        Some("ImportSpecifier")
            | Some("ImportDefaultSpecifier")
            | Some("ImportNamespaceSpecifier")
            | Some("ExportSpecifier")
    )
}

/// Is this Identifier a runtime *value* read (so a component name here escapes)?
/// Property keys, member names, and import/export specifier slots are not.
/// Mirrors `isValueUse` in analyze.ts.
fn is_value_use(node: &Value, parent: Option<&Value>) -> bool {
    let p = match parent {
        Some(p) => p,
        None => return false,
    };
    if str_eq(p, "type", "MemberExpression")
        && !bool_field(p, "computed")
        && same_node(get(p, "property"), node)
    {
        return false;
    }
    if str_eq(p, "type", "Property")
        && !bool_field(p, "computed")
        && p.get("shorthand").and_then(Value::as_bool) != Some(true)
        && same_node(get(p, "key"), node)
    {
        return false;
    }
    if is_import_specifier_position(p) {
        return false;
    }
    true
}

/// Every imported local name (svelte or not), from the instance script's import
/// declarations — needed for escape detection. Mirrors `importSources`' locals.
fn imported_locals(ast: &Value) -> HashSet<String> {
    let mut set = HashSet::new();
    let body = get(get(ast, "instance"), "content");
    for stmt in arr(body, "body") {
        if str_eq(stmt, "type", "ImportDeclaration") {
            for spec in arr(stmt, "specifiers") {
                if let Some(n) = get(spec, "local").get("name").and_then(Value::as_str) {
                    set.insert(n.to_string());
                }
            }
        }
    }
    set
}

/// Split the resolved outgoing edges of one component into the two local-name ->
/// child-id maps the analysis reads: direct default-`.svelte` imports (which drive
/// the value sets) and barrel/named imports (disjoint).
fn edge_maps(edges: &Value) -> (HashMap<String, String>, HashMap<String, String>) {
    let mut imports = HashMap::new();
    let mut barrel = HashMap::new();
    for e in edges.as_array().map(Vec::as_slice).unwrap_or(&[]) {
        let (local, to) = match (
            e.get("local").and_then(Value::as_str),
            e.get("to").and_then(Value::as_str),
        ) {
            (Some(l), Some(t)) => (l.to_string(), t.to_string()),
            _ => continue,
        };
        match e.get("kind").and_then(Value::as_str) {
            Some("default-svelte") => {
                imports.insert(local, to);
            }
            Some("barrel") => {
                barrel.insert(local, to);
            }
            _ => {}
        }
    }
    (imports, barrel)
}

/// Each `<Child .../>` this component renders that resolves to a default-`.svelte`
/// import, paired with its source span. Mirrors `collectChildCalls`.
fn child_calls(ast: &Value, imports: &HashMap<String, String>) -> Vec<Value> {
    let mut out = Vec::new();
    walk(get(ast, "fragment"), &mut |node| {
        if str_eq(node, "type", "Component") {
            if let Some(id) = node.get("name").and_then(Value::as_str).and_then(|n| imports.get(n)) {
                out.push(json!({ "childId": id, "start": get(node, "start"), "end": get(node, "end") }));
            }
        }
    });
    out
}

/// Barrel-resolved children this file actually RENDERS. Mirrors `collectBarrelChildIds`.
fn barrel_child_ids(ast: &Value, barrel: &HashMap<String, String>) -> Vec<String> {
    let mut out = Vec::new();
    if barrel.is_empty() {
        return out;
    }
    walk(get(ast, "fragment"), &mut |node| {
        if str_eq(node, "type", "Component") {
            if let Some(id) = node.get("name").and_then(Value::as_str).and_then(|n| barrel.get(n)) {
                out.push(id.clone());
            }
        }
    });
    sorted(out)
}

/// Imported components LEAKED as a value (escape, analyze.ts §4.1): a default-svelte
/// import referenced as an ordinary value (e.g. `<svelte:component this={X}>` or
/// assigned/passed in the instance script) rather than only as a `<X .../>` tag.
fn escaped_components(
    ast: &Value,
    imports: &HashMap<String, String>,
    imported: &HashSet<String>,
) -> Vec<String> {
    let mut out = Vec::new();
    // Template: any imported local read as a value (the dominant `<svelte:component
    // this={X}>` case) — only flag those that resolve to a `.svelte` import.
    walk_parented(get(ast, "fragment"), None, &mut |node, parent| {
        if str_eq(node, "type", "Identifier") {
            if let Some(name) = node.get("name").and_then(Value::as_str) {
                if imported.contains(name) && is_value_use(node, parent) {
                    if let Some(id) = imports.get(name) {
                        push_unique(&mut out, id);
                    }
                }
            }
        }
    });
    // Instance script: a component assigned to a var, pushed into an array, passed
    // to a function, etc. (import-specifier slots are excluded by `is_value_use`).
    walk_parented(get(ast, "instance"), None, &mut |node, parent| {
        if str_eq(node, "type", "Identifier") {
            if let Some(name) = node.get("name").and_then(Value::as_str) {
                if imports.contains_key(name) && is_value_use(node, parent) {
                    if let Some(id) = imports.get(name) {
                        push_unique(&mut out, id);
                    }
                }
            }
        }
    });
    sorted(out)
}

/// Analyze one component AST (JSON) given its resolved outgoing edges (JSON), and
/// return the per-file model fields ported so far: declared props, `...rest`
/// presence, shadowed / `{@debug}` fold-blocking names, the `<svelte:options>`
/// bail, the rendered child calls, barrel-rendered children, and escaped
/// components. `{"error": "..."}` on malformed input.
#[wasm_bindgen]
pub fn analyze_component(ast_json: &str, edges_json: &str) -> String {
    let ast: Value = match serde_json::from_str(ast_json) {
        Ok(v) => v,
        Err(e) => return json!({ "error": e.to_string() }).to_string(),
    };
    let edges: Value = serde_json::from_str(edges_json).unwrap_or(Value::Null);
    let (imports, barrel) = edge_maps(&edges);
    let (props, has_rest) = declared_props(&ast);
    let (shadowed, debug) = template_bindings(&ast);
    json!({
        "props": props,
        "hasRestProp": has_rest,
        "shadowed": sorted(shadowed),
        "debug": sorted(debug),
        "bail": component_bail(&ast),
        "childCalls": child_calls(&ast, &imports),
        "barrelChildIds": barrel_child_ids(&ast, &barrel),
        "escaped": escaped_components(&ast, &imports, &imported_locals(&ast)),
    })
    .to_string()
}

// ======================================================================
// Whole-program analysis (docs/RUST-MIGRATION.md M4): aggregate every call site
// into per-prop value sets, decide a plan per component, and iterate to a
// fixpoint — the Rust port of analyze.ts's buildUsage/buildPlan/valueSetFor +
// dead.ts's decideChain/computeDeadSpans.  Validated by `plans == TS plans`.
// ======================================================================

const ESCAPE_REASON: &str = "escapes as value (e.g. <svelte:component this={X}>)";
const BARREL_REASON: &str = "rendered through a barrel/named import (call sites unobservable)";
const MAX_FIXPOINT_ITERATIONS: usize = 10;

type Span = (i64, i64);

fn off(node: &Value, key: &str) -> i64 {
    node.get(key).and_then(Value::as_i64).unwrap_or(0)
}

fn in_spans(node: &Value, spans: &[Span]) -> bool {
    let (s, e) = (off(node, "start"), off(node, "end"));
    spans.iter().any(|&(a, b)| s >= a && e <= b)
}

/// `SameValue` dedup (JS `Object.is`): NaN == NaN, +0 != -0.
fn object_is(a: &Literal, b: &Literal) -> bool {
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

fn push_literal_unique(values: &mut Vec<Literal>, v: Literal) {
    if !values.iter().any(|x| object_is(x, &v)) {
        values.push(v);
    }
}

// ---- prop declarations with defaults --------------------------------------

struct PropDecl {
    name: String,
    /// The default-value expression node, or `Null` when omitted.
    default: Value,
    /// The `Property` node inside the `ObjectPattern` (for surgical removal).
    property: Value,
}

/// The `$props()` destructuring of a component, when present.
struct PropsInfo {
    props: Vec<PropDecl>,
    has_rest: bool,
    /// `$props()` is not the sole declarator of its statement (a conservative bail).
    shares_statement: bool,
    /// The `ObjectPattern` (for editing) and the whole `VariableDeclaration`.
    pattern: Value,
    declaration: Value,
}

/// `findPropsDeclaration` + the prop loop. `None` when the component has no
/// `$props()` destructuring.
fn declared_props_full(ast: &Value) -> Option<PropsInfo> {
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
                                let value = get(p, "value");
                                let default = if str_eq(value, "type", "AssignmentPattern") {
                                    get(value, "right").clone()
                                } else {
                                    Value::Null
                                };
                                props.push(PropDecl { name: name.to_string(), default, property: p.clone() });
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

// ---- call-site reading -----------------------------------------------------

struct ExplicitProp {
    value: Option<Literal>, // None when `dynamic`
    dynamic: bool,
    after_last_spread: bool,
}

struct CallSite {
    had_spread: bool,
    explicit: HashMap<String, ExplicitProp>,
}

fn dynamic_write(index: i64, last_spread: i64) -> ExplicitProp {
    ExplicitProp { value: None, dynamic: true, after_last_spread: index > last_spread }
}

/// Read a literal off an attribute `value` (true | node | node[]); `None` => not
/// statically known. Mirrors `literalAttrValue`.
fn literal_attr_value(value: &Value) -> Option<Literal> {
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
        return match type_of(part) {
            Some("Text") => Some(Literal::Str(text_data(part))),
            Some("ExpressionTag") if str_eq(get(part, "expression"), "type", "Literal") => {
                Literal::from_node_value(get(part, "expression").get("value")?)
            }
            _ => None,
        };
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

fn text_data(node: &Value) -> String {
    node.get("data")
        .or_else(|| node.get("raw"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// Props supplied through a `<Child>…</Child>` body: `children` for any
/// renderable content + one per named `{#snippet}`. Mirrors `synthesizedBodyProps`.
fn synthesized_body_props(component: &Value) -> Vec<String> {
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

/// Read one `<Child .../>` into a {@link CallSite} (last-write-wins + spread
/// tracking + synthesized body props). Mirrors `readCallSite`.
fn read_call_site(component: &Value) -> CallSite {
    let attrs = arr(component, "attributes");
    let mut last_spread: i64 = -1;
    for (i, a) in attrs.iter().enumerate() {
        if type_of(a) == Some("SpreadAttribute") {
            last_spread = i as i64;
        }
    }
    let mut explicit: HashMap<String, ExplicitProp> = HashMap::new();
    for (i, attr) in attrs.iter().enumerate() {
        let i = i as i64;
        let name = attr.get("name").and_then(Value::as_str);
        if type_of(attr) == Some("BindDirective") {
            if let Some(n) = name {
                explicit.insert(n.to_string(), dynamic_write(i, last_spread));
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
        match literal_attr_value(get(attr, "value")) {
            Some(v) => {
                explicit.insert(
                    name.to_string(),
                    ExplicitProp { value: Some(v), dynamic: false, after_last_spread: i > last_spread },
                );
            }
            None => {
                explicit.insert(name.to_string(), dynamic_write(i, last_spread));
            }
        }
    }
    for name in synthesized_body_props(component) {
        explicit.insert(name, dynamic_write(attrs.len() as i64, last_spread));
    }
    CallSite { had_spread: last_spread >= 0, explicit }
}

// ---- value-set join + plan -------------------------------------------------

struct PropValueSet {
    values: Vec<Literal>,
    dynamic: bool,
    top: bool,
}

fn literal_default(expr: &Value) -> Option<Literal> {
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

fn value_set_for(decl: &PropDecl, sites: &[CallSite]) -> PropValueSet {
    let mut values = Vec::new();
    let mut dynamic = false;
    let mut top = false;
    for site in sites {
        match site.explicit.get(&decl.name) {
            Some(e) if e.after_last_spread => {
                if e.dynamic {
                    dynamic = true;
                } else if let Some(v) = &e.value {
                    push_literal_unique(&mut values, v.clone());
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

struct ComponentPlan {
    id: String,
    bail: bool,
    reasons: Vec<String>,
    const_fold: Vec<(String, Literal)>,
    narrow: Vec<(String, Vec<Literal>)>,
    value_sets: Vec<(String, PropValueSet)>,
}

impl ComponentPlan {
    fn empty(id: &str) -> ComponentPlan {
        ComponentPlan {
            id: id.to_string(),
            bail: false,
            reasons: Vec::new(),
            const_fold: Vec::new(),
            narrow: Vec::new(),
            value_sets: Vec::new(),
        }
    }
    fn const_env(&self) -> Env {
        self.const_fold.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }
    fn set_env(&self) -> SetEnv {
        self.narrow.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }
}

fn is_fold_blocked(model: &Model, name: &str) -> bool {
    model.shadowed.contains(name) || model.debug.contains(name)
}

fn build_plan(model: &Model, sites: Option<&Vec<CallSite>>) -> ComponentPlan {
    let mut plan = ComponentPlan::empty(&model.id);
    if !model.bail_reasons.is_empty() {
        plan.bail = true;
        plan.reasons = model.bail_reasons.clone();
        return plan;
    }
    let props = match &model.props_info {
        Some(pi) if !pi.props.is_empty() => &pi.props,
        _ => return plan,
    };
    let sites = match sites {
        Some(s) if !s.is_empty() => s,
        _ => return plan,
    };
    for decl in props {
        if is_fold_blocked(model, &decl.name) {
            continue;
        }
        let set = value_set_for(decl, sites);
        let (dynamic, top) = (set.dynamic, set.top);
        let len = set.values.len();
        plan.value_sets.push((decl.name.clone(), set));
        if dynamic || top {
            continue;
        }
        if len == 1 {
            let v = plan.value_sets.last().unwrap().1.values[0].clone();
            plan.const_fold.push((decl.name.clone(), v));
        } else if len >= 2 {
            let vs = plan.value_sets.last().unwrap().1.values.clone();
            plan.narrow.push((decl.name.clone(), vs));
        }
    }
    plan
}

// ---- dead-span folding (decideChain) ---------------------------------------

struct ChainArm {
    block: Value,
    test: Value,
    consequent: Value,
}

fn collect_chain(top: &Value) -> (Vec<ChainArm>, Option<Value>) {
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

fn fragment_span(fragment: &Value) -> Option<Span> {
    let nodes = fragment.get("nodes").and_then(Value::as_array)?;
    if nodes.is_empty() {
        return None;
    }
    Some((off(&nodes[0], "start"), off(&nodes[nodes.len() - 1], "end")))
}

fn around_kept(span: Span, inner: Option<Span>) -> Vec<Span> {
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

fn consequent_end(consequent: &Value, fallback: i64) -> i64 {
    match consequent.get("nodes").and_then(Value::as_array) {
        Some(n) if !n.is_empty() => off(&n[n.len() - 1], "end"),
        _ => fallback,
    }
}

fn dead_tail(arms: &[ChainArm], truth: &[Option<bool>], from: usize) -> Vec<Span> {
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
struct ChainDecision {
    span: Span,
    removed: Vec<Span>,
    /// Consequent/else fragment to re-emit verbatim when the chain collapses.
    kept: Option<Value>,
    recurse: bool,
    /// Promote a surviving `{:else if}` to `{#if}`: replace `[from,to)` with `text`.
    header_rewrite: Option<(i64, i64, String)>,
}

fn decide_chain(top: &Value, env: &Env, set_env: &SetEnv) -> ChainDecision {
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

fn compute_dead_spans(fragment: &Value, env: &Env, set_env: &SetEnv) -> Vec<Span> {
    if env.is_empty() && set_env.is_empty() {
        return Vec::new();
    }
    let mut dead = Vec::new();
    collect_dead(fragment, env, set_env, &mut dead);
    dead
}

fn collect_dead(node: &Value, env: &Env, set_env: &SetEnv, dead: &mut Vec<Span>) {
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

// ---- model + fixpoint ------------------------------------------------------

struct Model {
    id: String,
    ast: Value,
    imports: HashMap<String, String>, // local -> childId (default-svelte), for call-site edits
    props_info: Option<PropsInfo>,
    shadowed: HashSet<String>,
    debug: HashSet<String>,
    /// (childId, the `<Child/>` Component node) for every rendered direct child.
    child_calls: Vec<(String, Value)>,
    escaped: Vec<String>,
    barrel: Vec<String>,
    bail_reasons: Vec<String>,
}

fn build_model_full(id: &str, ast: Value, edges: &[Value]) -> Model {
    let (imports, barrel_locals) = edge_maps(&Value::Array(edges.to_vec()));
    let props_info = declared_props_full(&ast);
    let (shadowed_vec, debug_vec) = template_bindings(&ast);
    let mut bail_reasons = component_bail(&ast);
    if props_info.as_ref().map(|p| p.shares_statement).unwrap_or(false) {
        bail_reasons.push("$props() shares a multi-declarator statement".to_string());
    }
    let mut child_calls = Vec::new();
    walk(get(&ast, "fragment"), &mut |n| {
        if str_eq(n, "type", "Component") {
            if let Some(cid) = n.get("name").and_then(Value::as_str).and_then(|nm| imports.get(nm)) {
                child_calls.push((cid.clone(), n.clone()));
            }
        }
    });
    let imported = imported_locals(&ast);
    let escaped = escaped_components(&ast, &imports, &imported);
    let barrel = barrel_child_ids(&ast, &barrel_locals);
    Model {
        id: id.to_string(),
        ast,
        imports,
        props_info,
        shadowed: shadowed_vec.into_iter().collect(),
        debug: debug_vec.into_iter().collect(),
        child_calls,
        escaped,
        barrel,
        bail_reasons,
    }
}

type Plans = HashMap<String, ComponentPlan>;

fn build_usage(models: &[Model], dead: &HashMap<String, Vec<Span>>) -> HashMap<String, Vec<CallSite>> {
    let mut usage: HashMap<String, Vec<CallSite>> = HashMap::new();
    for model in models {
        let empty = Vec::new();
        let spans = dead.get(&model.id).unwrap_or(&empty);
        for (child_id, node) in &model.child_calls {
            if !spans.is_empty() && in_spans(node, spans) {
                continue; // folded-away call site: excluded from the child's profile
            }
            usage.entry(child_id.clone()).or_default().push(read_call_site(node));
        }
    }
    usage
}

fn build_plans(models: &[Model], usage: &HashMap<String, Vec<CallSite>>) -> Plans {
    models.iter().map(|m| (m.id.clone(), build_plan(m, usage.get(&m.id)))).collect()
}

fn dead_spans_for_plans(models: &[Model], plans: &Plans) -> HashMap<String, Vec<Span>> {
    let mut out = HashMap::new();
    for model in models {
        let plan = &plans[&model.id];
        if plan.bail {
            continue;
        }
        let spans = compute_dead_spans(get(&model.ast, "fragment"), &plan.const_env(), &plan.set_env());
        if !spans.is_empty() {
            out.insert(model.id.clone(), spans);
        }
    }
    out
}

fn plans_equal(a: &Plans, b: &Plans) -> bool {
    if a.len() != b.len() {
        return false;
    }
    for (id, pa) in a {
        let pb = match b.get(id) {
            Some(p) => p,
            None => return false,
        };
        if pa.bail != pb.bail || pa.const_fold != pb.const_fold || pa.narrow != pb.narrow {
            return false;
        }
    }
    true
}

fn run_fixpoint(models: &[Model]) -> Plans {
    let mut plans = build_plans(models, &build_usage(models, &HashMap::new()));
    for _ in 0..MAX_FIXPOINT_ITERATIONS {
        let dead = dead_spans_for_plans(models, &plans);
        let next = build_plans(models, &build_usage(models, &dead));
        if plans_equal(&plans, &next) {
            plans = next;
            break;
        }
        plans = next;
    }
    plans
}

/// Encode a literal for the plan JSON; `undefined` uses a sentinel object so it
/// stays distinct from `null` across the boundary (the differential test mirrors it).
fn literal_to_plan_json(v: &Literal) -> Value {
    match v {
        Literal::Undefined => json!({ "$undefined": true }),
        other => other.to_json(),
    }
}

fn plan_to_json(plan: &ComponentPlan) -> Value {
    let const_fold: serde_json::Map<String, Value> =
        plan.const_fold.iter().map(|(k, v)| (k.clone(), literal_to_plan_json(v))).collect();
    let narrow: serde_json::Map<String, Value> = plan
        .narrow
        .iter()
        .map(|(k, vs)| (k.clone(), Value::Array(vs.iter().map(literal_to_plan_json).collect())))
        .collect();
    let value_sets: serde_json::Map<String, Value> = plan
        .value_sets
        .iter()
        .map(|(k, s)| {
            (
                k.clone(),
                json!({
                    "values": s.values.iter().map(literal_to_plan_json).collect::<Vec<_>>(),
                    "dynamic": s.dynamic,
                    "top": s.top,
                }),
            )
        })
        .collect();
    json!({
        "id": plan.id,
        "bail": plan.bail,
        "reasons": plan.reasons,
        "constFold": const_fold,
        "narrow": narrow,
        "valueSets": value_sets,
    })
}

/// Whole-program analysis entry: `input` is `{ files: [{id, ast}], edges:
/// [{from, local, to, kind}], entries }` (the AST is parsed on the JS side).
/// Returns `{ id: plan }` for every component.
#[wasm_bindgen]
pub fn analyze_program(input_json: &str) -> String {
    let input: Value = match serde_json::from_str(input_json) {
        Ok(v) => v,
        Err(e) => return json!({ "error": e.to_string() }).to_string(),
    };
    // Group resolved edges by their owning file.
    let mut edges_by_from: HashMap<String, Vec<Value>> = HashMap::new();
    for e in input.get("edges").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
        if let Some(from) = e.get("from").and_then(Value::as_str) {
            edges_by_from.entry(from.to_string()).or_default().push(e.clone());
        }
    }
    let mut models: Vec<Model> = Vec::new();
    for f in input.get("files").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
        let id = match f.get("id").and_then(Value::as_str) {
            Some(i) => i.to_string(),
            None => continue,
        };
        let ast = f.get("ast").cloned().unwrap_or(Value::Null);
        let empty = Vec::new();
        let edges = edges_by_from.get(&id).unwrap_or(&empty);
        models.push(build_model_full(&id, ast, edges));
    }

    // Program-wide escape/barrel bail (analyze.ts §4.1/§4.2).
    let mut escaped = HashSet::new();
    let mut barreled = HashSet::new();
    for m in &models {
        for id in &m.escaped {
            escaped.insert(id.clone());
        }
        for id in &m.barrel {
            barreled.insert(id.clone());
        }
    }
    for m in &mut models {
        if escaped.contains(&m.id) && !m.bail_reasons.iter().any(|r| r == ESCAPE_REASON) {
            m.bail_reasons.push(ESCAPE_REASON.to_string());
        }
        if barreled.contains(&m.id) && !m.bail_reasons.iter().any(|r| r == BARREL_REASON) {
            m.bail_reasons.push(BARREL_REASON.to_string());
        }
    }

    let plans = run_fixpoint(&models);
    let out: serde_json::Map<String, Value> =
        plans.iter().map(|(id, plan)| (id.clone(), plan_to_json(plan))).collect();
    Value::Object(out).to_string()
}

// ======================================================================
// Transform + emit (docs/RUST-MIGRATION.md M5): the Rust port of transform.ts +
// css.ts.  Edits the original source by surgical span removal/overwrite via
// MagicEdit, sharing decide_chain with the analysis so folds never disagree.
// All source access goes through the MagicEdit (UTF-16 units), so it is correct
// for non-ASCII source.
// ======================================================================

const NL: u16 = b'\n' as u16;
const SEMI: u16 = b';' as u16;

fn is_ws_u16(u: u16) -> bool {
    u == b' ' as u16 || u == b'\t' as u16 || u == b'\n' as u16 || u == b'\r' as u16
}

/// `isNonReference`: an Identifier used as a property key / member name / import
/// specifier slot — not a value read, so a literal must NOT be substituted there.
fn is_non_reference(node: &Value, parent: Option<&Value>) -> bool {
    let p = match parent {
        Some(p) => p,
        None => return false,
    };
    if str_eq(p, "type", "MemberExpression") && !bool_field(p, "computed") && same_node(get(p, "property"), node) {
        return true;
    }
    if str_eq(p, "type", "Property")
        && !bool_field(p, "computed")
        && p.get("shorthand").and_then(Value::as_bool) != Some(true)
        && same_node(get(p, "key"), node)
    {
        return true;
    }
    is_import_specifier_position(p)
}

/// `substitutedSlice`: the source for `[from,to)` with every folded-prop reference
/// inside `roots` replaced by its literal.
fn substituted_slice(edits: &MagicEdit, from: i64, to: i64, roots: &[&Value], env: &Env) -> String {
    if env.is_empty() {
        return edits.slice(from as usize, to as usize);
    }
    let mut refs: Vec<(i64, i64, String)> = Vec::new();
    for root in roots {
        walk_parented(root, None, &mut |node, parent| {
            if str_eq(node, "type", "Identifier") {
                if let Some(name) = node.get("name").and_then(Value::as_str) {
                    if env.contains_key(name) && !is_non_reference(node, parent) {
                        refs.push((off(node, "start"), off(node, "end"), name.to_string()));
                    }
                }
            }
        });
    }
    if refs.is_empty() {
        return edits.slice(from as usize, to as usize);
    }
    refs.sort_by_key(|r| r.0);
    let mut out = String::new();
    let mut cursor = from;
    for (s, e, name) in refs {
        out.push_str(&edits.slice(cursor as usize, s as usize));
        out.push_str(&env[&name].to_source());
        cursor = e;
    }
    out.push_str(&edits.slice(cursor as usize, to as usize));
    out
}

fn fragment_source(edits: &MagicEdit, fragment: &Value, env: &Env) -> String {
    match fragment.get("nodes").and_then(Value::as_array) {
        Some(n) if !n.is_empty() => {
            let from = off(&n[0], "start");
            let to = off(&n[n.len() - 1], "end");
            let roots: Vec<&Value> = n.iter().collect();
            substituted_slice(edits, from, to, &roots, env)
        }
        _ => String::new(),
    }
}

fn apply_chain(decision: &ChainDecision, env: &Env, edits: &mut MagicEdit) {
    if let Some(frag) = &decision.kept {
        let text = fragment_source(edits, frag, env);
        edits.overwrite(decision.span.0 as usize, decision.span.1 as usize, &text);
        return;
    }
    for (a, b) in &decision.removed {
        edits.remove(*a as usize, *b as usize);
    }
    if let Some((from, to, text)) = &decision.header_rewrite {
        edits.overwrite(*from as usize, *to as usize, text);
    }
}

fn fold_if_blocks(node: &Value, env: &Env, set_env: &SetEnv, edits: &mut MagicEdit, dead: &mut Vec<Span>) {
    match node {
        Value::Array(items) => {
            for v in items {
                fold_if_blocks(v, env, set_env, edits, dead);
            }
        }
        Value::Object(map) => {
            if type_of(node) == Some("IfBlock") {
                if node.get("elseif") == Some(&Value::Bool(true)) || in_spans(node, dead) {
                    return;
                }
                let decision = decide_chain(node, env, set_env);
                apply_chain(&decision, env, edits);
                if decision.kept.is_some() {
                    dead.push(decision.span);
                } else {
                    dead.extend(decision.removed.iter().copied());
                }
                if decision.recurse {
                    for v in map.values() {
                        fold_if_blocks(v, env, set_env, edits, dead);
                    }
                }
                return;
            }
            for v in map.values() {
                fold_if_blocks(v, env, set_env, edits, dead);
            }
        }
        _ => {}
    }
}

fn fold_ternaries(node: &Value, env: &Env, edits: &mut MagicEdit, dead: &mut Vec<Span>) {
    match node {
        Value::Array(items) => {
            for v in items {
                fold_ternaries(v, env, edits, dead);
            }
        }
        Value::Object(map) => {
            if type_of(node) == Some("ConditionalExpression") {
                if in_spans(node, dead) {
                    return;
                }
                match evaluate(get(node, "test"), env) {
                    None => {
                        for v in map.values() {
                            fold_ternaries(v, env, edits, dead);
                        }
                    }
                    Some(t) => {
                        let taken = if t.is_truthy() { get(node, "consequent") } else { get(node, "alternate") };
                        if taken.is_null() {
                            for v in map.values() {
                                fold_ternaries(v, env, edits, dead);
                            }
                            return;
                        }
                        let text = substituted_slice(edits, off(taken, "start"), off(taken, "end"), &[taken], env);
                        edits.overwrite(off(node, "start") as usize, off(node, "end") as usize, &text);
                        dead.push((off(node, "start"), off(node, "end")));
                    }
                }
                return;
            }
            for v in map.values() {
                fold_ternaries(v, env, edits, dead);
            }
        }
        _ => {}
    }
}

fn collect_prop_refs(model: &Model, env: &Env, dead: &[Span]) -> Vec<(i64, i64, String)> {
    let mut refs = Vec::new();
    let mut collect = |node: &Value, parent: Option<&Value>| {
        if str_eq(node, "type", "Identifier") {
            if let Some(name) = node.get("name").and_then(Value::as_str) {
                if env.contains_key(name) && !in_spans(node, dead) && !is_non_reference(node, parent) {
                    refs.push((off(node, "start"), off(node, "end"), name.to_string()));
                }
            }
        }
    };
    walk_parented(get(&model.ast, "instance"), None, &mut collect);
    walk_parented(get(&model.ast, "fragment"), None, &mut collect);
    refs
}

fn remove_pattern_property(properties: &[Value], property: &Value, edits: &mut MagicEdit) {
    let i = match properties.iter().position(|p| same_node(p, property)) {
        Some(i) => i,
        None => return,
    };
    if let Some(next) = properties.get(i + 1) {
        edits.remove(off(property, "start") as usize, off(next, "start") as usize);
    } else if i > 0 {
        edits.remove(off(&properties[i - 1], "end") as usize, off(property, "end") as usize);
    } else {
        edits.remove(off(property, "start") as usize, off(property, "end") as usize);
    }
}

fn remove_type_member(pattern: &Value, name: &str, edits: &mut MagicEdit) {
    let members = get(get(get(pattern, "typeAnnotation"), "typeAnnotation"), "members");
    let members = match members.as_array() {
        Some(m) => m,
        None => return,
    };
    let i = members.iter().position(|m| {
        str_eq(get(m, "key"), "type", "Identifier") && get(m, "key").get("name").and_then(Value::as_str) == Some(name)
    });
    let i = match i {
        Some(i) => i,
        None => return,
    };
    if let Some(next) = members.get(i + 1) {
        edits.remove(off(&members[i], "start") as usize, off(next, "start") as usize);
    } else if i > 0 {
        edits.remove(off(&members[i - 1], "end") as usize, off(&members[i], "end") as usize);
    } else {
        edits.remove(off(&members[i], "start") as usize, off(&members[i], "end") as usize);
    }
}

fn remove_whole_line(node: &Value, edits: &mut MagicEdit) {
    let start = off(node, "start") as usize;
    let end = off(node, "end") as usize;
    let len = edits.len();
    let mut line_start = start;
    while line_start > 0 && edits.unit_at(line_start - 1) != Some(NL) {
        line_start -= 1;
    }
    let mut line_end = end;
    while line_end < len && edits.unit_at(line_end) != Some(NL) {
        line_end += 1;
    }
    let prefix = edits.slice(line_start, start);
    let suffix = edits.slice(end, line_end);
    let suffix_non_ws: String = suffix.chars().filter(|c| !c.is_whitespace()).collect();
    if prefix.trim().is_empty() && (suffix_non_ws.is_empty() || suffix_non_ws == ";") {
        let rm_end = if line_end < len { line_end + 1 } else { line_end };
        edits.remove(line_start, rm_end);
    } else {
        let rm_end = if edits.unit_at(end) == Some(SEMI) { end + 1 } else { end };
        edits.remove(start, rm_end);
    }
}

fn drop_props(model: &Model, drop: &HashSet<String>, edits: &mut MagicEdit) {
    let pi = match &model.props_info {
        Some(p) => p,
        None => return,
    };
    if drop.is_empty() {
        return;
    }
    let remaining = pi.props.iter().filter(|p| !drop.contains(&p.name)).count();
    if remaining == 0 && !pi.has_rest {
        remove_whole_line(&pi.declaration, edits);
        return;
    }
    let properties = arr(&pi.pattern, "properties");
    for decl in &pi.props {
        if !drop.contains(&decl.name) {
            continue;
        }
        remove_pattern_property(properties, &decl.property, edits);
        remove_type_member(&pi.pattern, &decl.name, edits);
    }
}

/// A call-site attribute is safe to delete only if its value has no side effects.
fn is_side_effect_free(value: &Value) -> bool {
    if value == &Value::Bool(true) || value.is_null() {
        return true;
    }
    let single;
    let parts: &[Value] = match value.as_array() {
        Some(a) => a,
        None => {
            single = [value.clone()];
            &single
        }
    };
    parts.iter().all(|part| match type_of(part) {
        Some("Text") => true,
        Some("ExpressionTag") => str_eq(get(part, "expression"), "type", "Literal"),
        _ => false,
    })
}

fn remove_attr_with_space(attr: &Value, edits: &mut MagicEdit) {
    let mut start = off(attr, "start") as usize;
    if start > 0 && matches!(edits.unit_at(start - 1), Some(c) if c == b' ' as u16 || c == b'\t' as u16) {
        start -= 1;
    }
    edits.remove(start, off(attr, "end") as usize);
}

fn remove_call_site_attributes(model: &Model, dropped: &HashMap<String, HashSet<String>>, edits: &mut MagicEdit) {
    // Collect first (so we don't borrow the ast through `walk` while editing).
    let mut to_remove: Vec<Value> = Vec::new();
    walk(get(&model.ast, "fragment"), &mut |node| {
        if !str_eq(node, "type", "Component") {
            return;
        }
        let drop = node
            .get("name")
            .and_then(Value::as_str)
            .and_then(|n| model.imports.get(n))
            .and_then(|cid| dropped.get(cid));
        if let Some(drop) = drop {
            if drop.is_empty() {
                return;
            }
            for attr in arr(node, "attributes") {
                if type_of(attr) == Some("Attribute") {
                    if let Some(name) = attr.get("name").and_then(Value::as_str) {
                        if drop.contains(name) && is_side_effect_free(get(attr, "value")) {
                            to_remove.push(attr.clone());
                        }
                    }
                }
            }
        }
    });
    for attr in &to_remove {
        remove_attr_with_space(attr, edits);
    }
}

// ---- CSS rule removal (css.ts) ---------------------------------------------

const MAX_CLASS_COMBOS: usize = 64;

struct PossibleClasses {
    classes: HashSet<String>,
    unbounded: bool,
}

fn is_element_like(t: Option<&str>) -> bool {
    matches!(
        t,
        Some("RegularElement") | Some("SvelteElement") | Some("Component") | Some("SvelteComponent") | Some("SvelteSelf")
    )
}

/// Possible string values of one interpolated `{expr}` in a class attribute, or
/// `None` (UNBOUNDED). A bare set-var enumerates its set; else it must fold.
fn expression_strings(expr: &Value, env: &Env, set_env: &SetEnv) -> Option<HashSet<String>> {
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

fn part_strings(part: &Value, env: &Env, set_env: &SetEnv) -> Option<HashSet<String>> {
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
fn class_tokens_from_attr(value: &Value, env: &Env, set_env: &SetEnv) -> Option<HashSet<String>> {
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

fn compute_possible_classes(model: &Model, env: &Env, set_env: &SetEnv) -> PossibleClasses {
    let mut classes = HashSet::new();
    let mut unbounded = false;
    walk(get(&model.ast, "fragment"), &mut |node| {
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

fn has_global(rule: &Value) -> bool {
    let mut found = false;
    walk(rule, &mut |n| {
        if str_eq(n, "type", "PseudoClassSelector") && n.get("name").and_then(Value::as_str) == Some("global") {
            found = true;
        }
    });
    found
}

fn is_complex_dead(complex: &Value, possible: &HashSet<String>) -> bool {
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

fn is_rule_dead(rule: &Value, possible: &HashSet<String>) -> bool {
    if has_global(rule) {
        return false;
    }
    let complexes = get(rule, "prelude").get("children").and_then(Value::as_array);
    match complexes {
        Some(c) if !c.is_empty() => c.iter().all(|complex| is_complex_dead(complex, possible)),
        _ => false,
    }
}

fn remove_rule(rule: &Value, siblings: &[Value], edits: &mut MagicEdit) {
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

fn shake_css(model: &Model, env: &Env, set_env: &SetEnv, edits: &mut MagicEdit) {
    let css = get(&model.ast, "css");
    let children = match css.get("children").and_then(Value::as_array) {
        Some(c) => c.clone(),
        None => return,
    };
    let possible = compute_possible_classes(model, env, set_env);
    if possible.unbounded {
        return; // cannot bound the class set -> removing nothing is the only sound choice
    }
    for child in &children {
        if type_of(child) == Some("Rule") && is_rule_dead(child, &possible.classes) {
            remove_rule(child, &children, edits);
        }
    }
}

/// Slim one component into `edits`, returning the props dropped from the
/// `$props()` signature (mirrors `shakeBody`).
fn shake_body(model: &Model, env: &Env, set_env: &SetEnv, edits: &mut MagicEdit) -> HashSet<String> {
    if env.is_empty() && set_env.is_empty() {
        return HashSet::new();
    }
    let fragment = get(&model.ast, "fragment");
    let mut dead: Vec<Span> = Vec::new();
    fold_if_blocks(fragment, env, set_env, edits, &mut dead);
    if !env.is_empty() {
        fold_ternaries(fragment, env, edits, &mut dead);
    }
    for (s, e, name) in collect_prop_refs(model, env, &dead) {
        edits.overwrite(s as usize, e as usize, &env[&name].to_source());
    }
    let droppable: HashSet<String> = env.keys().cloned().collect();
    drop_props(model, &droppable, edits);
    shake_css(model, env, set_env, edits);
    droppable
}

/// Whole-program shake: analyze + transform.  `input` is `{ files: [{id, ast,
/// code}], edges, entries }`.  Returns `{ id: slimmedSource }` for every file —
/// byte-for-byte the L0/L1/L1.5 output (the `svelteShaker` equivalent).
#[wasm_bindgen]
pub fn shake_program(input_json: &str) -> String {
    let input: Value = match serde_json::from_str(input_json) {
        Ok(v) => v,
        Err(e) => return json!({ "error": e.to_string() }).to_string(),
    };
    let mut edges_by_from: HashMap<String, Vec<Value>> = HashMap::new();
    for e in input.get("edges").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
        if let Some(from) = e.get("from").and_then(Value::as_str) {
            edges_by_from.entry(from.to_string()).or_default().push(e.clone());
        }
    }
    let mut models: Vec<Model> = Vec::new();
    let mut code_by_id: HashMap<String, String> = HashMap::new();
    for f in input.get("files").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
        let id = match f.get("id").and_then(Value::as_str) {
            Some(i) => i.to_string(),
            None => continue,
        };
        let ast = f.get("ast").cloned().unwrap_or(Value::Null);
        code_by_id.insert(id.clone(), f.get("code").and_then(Value::as_str).unwrap_or("").to_string());
        let empty = Vec::new();
        let edges = edges_by_from.get(&id).unwrap_or(&empty);
        models.push(build_model_full(&id, ast, edges));
    }

    let mut escaped = HashSet::new();
    let mut barreled = HashSet::new();
    for m in &models {
        escaped.extend(m.escaped.iter().cloned());
        barreled.extend(m.barrel.iter().cloned());
    }
    for m in &mut models {
        if escaped.contains(&m.id) && !m.bail_reasons.iter().any(|r| r == ESCAPE_REASON) {
            m.bail_reasons.push(ESCAPE_REASON.to_string());
        }
        if barreled.contains(&m.id) && !m.bail_reasons.iter().any(|r| r == BARREL_REASON) {
            m.bail_reasons.push(BARREL_REASON.to_string());
        }
    }

    let plans = run_fixpoint(&models);

    // Phase 1: fold each body and drop its folded props.
    let mut edits_map: HashMap<String, MagicEdit> = HashMap::new();
    let mut dropped: HashMap<String, HashSet<String>> = HashMap::new();
    for model in &models {
        let plan = &plans[&model.id];
        let mut edits = MagicEdit::new(code_by_id.get(&model.id).map(String::as_str).unwrap_or(""));
        let d = if plan.bail {
            HashSet::new()
        } else {
            shake_body(model, &plan.const_env(), &plan.set_env(), &mut edits)
        };
        dropped.insert(model.id.clone(), d);
        edits_map.insert(model.id.clone(), edits);
    }
    // Phase 2: remove call-site attributes for props the child actually dropped.
    for model in &models {
        if let Some(edits) = edits_map.get_mut(&model.id) {
            remove_call_site_attributes(model, &dropped, edits);
        }
    }

    let out: serde_json::Map<String, Value> = models
        .iter()
        .map(|m| (m.id.clone(), Value::String(edits_map.get(&m.id).map(|e| e.render()).unwrap_or_default())))
        .collect();
    Value::Object(out).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn analyze(ast: &Value) -> Value {
        analyze_edges(ast, "[]")
    }

    fn analyze_edges(ast: &Value, edges: &str) -> Value {
        serde_json::from_str(&analyze_component(&ast.to_string(), edges)).unwrap()
    }

    #[test]
    fn extracts_props_and_rest() {
        let ast = json!({
            "type": "Root",
            "instance": { "content": { "body": [
                { "type": "VariableDeclaration", "declarations": [
                    { "type": "VariableDeclarator",
                      "id": { "type": "ObjectPattern", "properties": [
                          { "type": "Property", "key": { "type": "Identifier", "name": "variant" } },
                          { "type": "Property", "key": { "type": "Identifier", "name": "size" } },
                          { "type": "RestElement", "argument": { "type": "Identifier", "name": "rest" } }
                      ] },
                      "init": { "type": "CallExpression",
                                "callee": { "type": "Identifier", "name": "$props" } } }
                ] }
            ] } },
            "fragment": { "type": "Fragment", "nodes": [] }
        });
        let out = analyze(&ast);
        assert_eq!(out["props"], json!(["variant", "size"]));
        assert_eq!(out["hasRestProp"], json!(true));
        assert_eq!(out["shadowed"], json!([]));
    }

    #[test]
    fn collects_each_and_snippet_and_debug_bindings() {
        let ast = json!({
            "type": "Root",
            "instance": Value::Null,
            "fragment": { "type": "Fragment", "nodes": [
                { "type": "EachBlock",
                  "context": { "type": "ObjectPattern", "properties": [
                      { "type": "Property", "key": { "type": "Identifier", "name": "k" },
                        "value": { "type": "Identifier", "name": "item" } } ] },
                  "index": "i" },
                { "type": "SnippetBlock",
                  "expression": { "type": "Identifier", "name": "row" },
                  "parameters": [ { "type": "Identifier", "name": "p" } ] },
                { "type": "DebugTag", "identifiers": [ { "type": "Identifier", "name": "watched" } ] }
            ] }
        });
        let out = analyze(&ast);
        assert_eq!(out["shadowed"], json!(["i", "item", "p", "row"]));
        assert_eq!(out["debug"], json!(["watched"]));
    }

    #[test]
    fn flags_accessors_bail() {
        let ast = json!({
            "type": "Root", "instance": Value::Null,
            "fragment": { "type": "Fragment", "nodes": [
                { "type": "SvelteOptions", "attributes": [ { "type": "Attribute", "name": "accessors" } ] }
            ] }
        });
        assert_eq!(analyze(&ast)["bail"], json!(["<svelte:options accessors>"]));
    }

    #[test]
    fn collects_child_calls_and_escapes_via_edges() {
        // `<Child/>` is a rendered call; `<svelte:component this={Child}>` reads
        // `Child` as a VALUE, so the component escapes.
        let ast = json!({
            "type": "Root",
            "instance": { "content": { "body": [
                { "type": "ImportDeclaration", "specifiers": [
                    { "type": "ImportDefaultSpecifier", "local": { "type": "Identifier", "name": "Child" } } ] }
            ] } },
            "fragment": { "type": "Fragment", "nodes": [
                { "type": "Component", "name": "Child", "start": 50, "end": 59, "attributes": [], "fragment": { "nodes": [] } },
                { "type": "SvelteElement", "name": "svelte:component", "attributes": [
                    { "type": "Attribute", "name": "this", "value": [
                        { "type": "ExpressionTag", "expression": { "type": "Identifier", "name": "Child", "start": 90, "end": 95 } } ] } ] }
            ] }
        });
        let edges = r#"[{"local":"Child","to":"/Child.svelte","kind":"default-svelte"}]"#;
        let out = analyze_edges(&ast, edges);
        assert_eq!(out["childCalls"], json!([{ "childId": "/Child.svelte", "start": 50, "end": 59 }]));
        assert_eq!(out["escaped"], json!(["/Child.svelte"]));
    }

    #[test]
    fn barrel_child_only_when_rendered() {
        let ast = json!({
            "type": "Root", "instance": Value::Null,
            "fragment": { "type": "Fragment", "nodes": [
                { "type": "Component", "name": "Lib", "start": 0, "end": 6, "attributes": [], "fragment": { "nodes": [] } }
            ] }
        });
        let edges = r#"[{"local":"Lib","to":"/Lib.svelte","kind":"barrel"}]"#;
        assert_eq!(analyze_edges(&ast, edges)["barrelChildIds"], json!(["/Lib.svelte"]));
    }
}
