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
/// zimmerframe's `state.parent`. `descend` decides whether to enter an object
/// node: when it returns `false` the node is neither visited nor recursed into —
/// used to skip TS type-only subtrees in escape detection (see
/// `is_type_only_node`). Pass `&|_| true` for an unconditional walk.
fn walk_parented_pruned<'a, D: Fn(&Value) -> bool, F: FnMut(&Value, Option<&Value>)>(
    node: &'a Value,
    parent: Option<&'a Value>,
    descend: &D,
    f: &mut F,
) {
    match node {
        Value::Object(map) => {
            if !descend(node) {
                return;
            }
            f(node, parent);
            for v in map.values() {
                walk_parented_pruned(v, Some(node), descend, f);
            }
        }
        Value::Array(items) => {
            for v in items {
                walk_parented_pruned(v, parent, descend, f);
            }
        }
        _ => {}
    }
}

/// A TS type-only subtree the escape walk must NOT descend into: every `TSType*`
/// node (annotations, references/queries, type-argument and type-parameter
/// lists, …) plus `interface` declarations. Identifiers inside them — e.g.
/// `Button` in `ComponentProps<typeof Button>['pattern']`, or `Props` in
/// `: Props` — are type-level, erased at compile, never runtime value reads, so
/// descending would falsely flag the component as escaped and bail it whole.
/// `TSAsExpression` / `TSSatisfiesExpression` / `TSNonNullExpression` /
/// `TSInstantiationExpression` are NOT pruned (they wrap a real runtime
/// expression; their own type child is itself a `TSType*` node this prunes).
/// Mirrors analyze.ts `isTypeOnlyNode`.
fn is_type_only_node(node: &Value) -> bool {
    match type_of(node) {
        Some(t) => t.starts_with("TSType") || t == "TSInterfaceDeclaration",
        None => false,
    }
}

/// Like `walk_parented_pruned`, but always descends and also threads the
/// grandparent (the nearest object ancestor of the parent).  Arrays are not
/// nodes, so they pass parent and grandparent through unchanged.
fn walk_grandparented<'a, F: FnMut(&Value, Option<&Value>, Option<&Value>)>(
    node: &'a Value,
    parent: Option<&'a Value>,
    grandparent: Option<&'a Value>,
    f: &mut F,
) {
    match node {
        Value::Object(map) => {
            f(node, parent, grandparent);
            for v in map.values() {
                walk_grandparented(v, Some(node), parent, f);
            }
        }
        Value::Array(items) => {
            for v in items {
                walk_grandparented(v, parent, grandparent, f);
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

/// Build the tag-name -> child-id attribution map from a component's resolved
/// outgoing edges.  Every edge kind (`default-svelte`, `barrel`, `namespace`) is
/// attributable: its `local` is the exact tag a call site renders — a bare name
/// (`Child`) or a dotted member (`ns.Child`) — so all of them feed the value sets.
fn edge_imports(edges: &Value) -> HashMap<String, String> {
    let mut imports = HashMap::new();
    for e in edges.as_array().map(Vec::as_slice).unwrap_or(&[]) {
        if let (Some(l), Some(t)) = (
            e.get("local").and_then(Value::as_str),
            e.get("to").and_then(Value::as_str),
        ) {
            imports.insert(l.to_string(), t.to_string());
        }
    }
    imports
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

/// Namespace import locals (`import * as ns`).  If `ns` is read as a value the
/// whole namespace escapes, so every `ns.*` member must bail (see `flag_escape`).
fn namespace_locals(ast: &Value) -> HashSet<String> {
    let mut set = HashSet::new();
    let body = get(get(ast, "instance"), "content");
    for stmt in arr(body, "body") {
        if str_eq(stmt, "type", "ImportDeclaration") {
            for spec in arr(stmt, "specifiers") {
                if str_eq(spec, "type", "ImportNamespaceSpecifier") {
                    if let Some(n) = get(spec, "local").get("name").and_then(Value::as_str) {
                        set.insert(n.to_string());
                    }
                }
            }
        }
    }
    set
}

/// Flag the component(s) a leaked local `name` escapes: the one it directly binds,
/// plus — when `name` is a namespace object — every `ns.*` member it could render.
fn flag_escape(
    name: &str,
    imports: &HashMap<String, String>,
    namespace_locals: &HashSet<String>,
    out: &mut Vec<String>,
) {
    if let Some(id) = imports.get(name) {
        push_unique(out, id);
    }
    if namespace_locals.contains(name) {
        let prefix = format!("{name}.");
        for (local, id) in imports {
            if local.starts_with(&prefix) {
                push_unique(out, id);
            }
        }
    }
}

/// Imported components LEAKED as a value (escape, analyze.ts §4.1): an import
/// referenced as an ordinary value (e.g. `<svelte:component this={X}>` or
/// assigned/passed in the instance script) rather than only as a `<X .../>` tag.
fn escaped_components(
    ast: &Value,
    imports: &HashMap<String, String>,
    imported: &HashSet<String>,
    namespace_locals: &HashSet<String>,
) -> Vec<String> {
    let mut out = Vec::new();
    let not_type = |n: &Value| !is_type_only_node(n);
    // Template: any imported local read as a value (the dominant `<svelte:component
    // this={X}>` case) — only flag those that resolve to a `.svelte` import.
    // Type-only subtrees are skipped: erased at compile, never a runtime escape.
    walk_parented_pruned(get(ast, "fragment"), None, &not_type, &mut |node, parent| {
        if str_eq(node, "type", "Identifier") {
            if let Some(name) = node.get("name").and_then(Value::as_str) {
                if imported.contains(name) && is_value_use(node, parent) {
                    flag_escape(name, imports, namespace_locals, &mut out);
                }
            }
        }
    });
    // Instance script: a component assigned to a var, pushed into an array, passed
    // to a function, etc. (import-specifier slots are excluded by `is_value_use`).
    // Skip TS type positions (`ComponentProps<typeof X>`, `: Props`): type-level,
    // not value reads, so descending would falsely escape the component.
    walk_parented_pruned(get(ast, "instance"), None, &not_type, &mut |node, parent| {
        if str_eq(node, "type", "Identifier") {
            if let Some(name) = node.get("name").and_then(Value::as_str) {
                if (imports.contains_key(name) || namespace_locals.contains(name))
                    && is_value_use(node, parent)
                {
                    flag_escape(name, imports, namespace_locals, &mut out);
                }
            }
        }
    });
    sorted(out)
}

/// Analyze one component AST (JSON) given its resolved outgoing edges (JSON), and
/// return the per-file model fields ported so far: declared props, `...rest`
/// presence, shadowed / `{@debug}` fold-blocking names, the `<svelte:options>`
/// bail, the rendered child calls, and escaped components. `{"error": "..."}` on
/// malformed input.
#[wasm_bindgen]
pub fn analyze_component(ast_json: &str, edges_json: &str) -> String {
    let ast: Value = match serde_json::from_str(ast_json) {
        Ok(v) => v,
        Err(e) => return json!({ "error": e.to_string() }).to_string(),
    };
    let edges: Value = serde_json::from_str(edges_json).unwrap_or(Value::Null);
    let imports = edge_imports(&edges);
    let (props, has_rest) = declared_props(&ast);
    let (shadowed, debug) = template_bindings(&ast);
    json!({
        "props": props,
        "hasRestProp": has_rest,
        "shadowed": sorted(shadowed),
        "debug": sorted(debug),
        "bail": component_bail(&ast),
        "childCalls": child_calls(&ast, &imports),
        "escaped": escaped_components(&ast, &imports, &imported_locals(&ast), &namespace_locals(&ast)),
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
    /// The EXTERNAL prop name — the destructure KEY (`prop` in `prop: alias`).
    /// Call sites pass this name, so value sets / dropping key off it.  Mirrors
    /// `PropDecl.name` in analyze.ts.
    name: String,
    /// The LOCAL binding name the entry introduces in the body — the destructure
    /// VALUE (`alias` in `prop: alias`, or the bare name for a shorthand `prop`),
    /// or `None` when the entry binds a NESTED pattern (`prop: { x }`) rather than
    /// a single identifier.  Body and template references use THIS name, not
    /// {@link name} (`prop` and its alias `alias` can even be different entities —
    /// e.g. a same-named import), so folding/substitution must look props up by it.
    /// A `None` local is never foldable.  Mirrors `PropDecl.local` in analyze.ts.
    local: Option<String>,
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

/// The `[name, value]` entries a spread contributes IF it is a statically-known
/// object literal whose complete key set we can see. `None` => an opaque spread
/// (an identifier/call `{...rest}`, or an object literal carrying a nested spread,
/// a computed key, or a getter/setter/method) that may set any prop. Each value
/// is `Some(lit)` for a literal (so it folds) or `None` for a non-literal value
/// (key known, value dynamic). Mirrors `knownSpreadEntries` in analyze.ts.
fn known_spread_entries(attr: &Value) -> Option<Vec<(String, Option<Literal>)>> {
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
        entries.push((name, evaluate(get(prop, "value"), &empty)));
    }
    Some(entries)
}

/// Read one `<Child .../>` into a {@link CallSite} (last-write-wins + spread
/// tracking + synthesized body props). Mirrors `readCallSite`.
fn read_call_site(component: &Value) -> CallSite {
    let attrs = arr(component, "attributes");
    // Only spreads we cannot expand are opaque; a known object literal is expanded
    // into explicit writes below, so `after_last_spread` is measured against the
    // last *unknown* spread (mirrors readCallSite).
    let mut last_spread: i64 = -1;
    for (i, a) in attrs.iter().enumerate() {
        if type_of(a) == Some("SpreadAttribute") && known_spread_entries(a).is_none() {
            last_spread = i as i64;
        }
    }
    let mut explicit: HashMap<String, ExplicitProp> = HashMap::new();
    for (i, attr) in attrs.iter().enumerate() {
        let i = i as i64;
        if type_of(attr) == Some("SpreadAttribute") {
            // A known object-literal spread expands to one explicit write per key;
            // an unknown spread is opaque (handled via had_spread/after_last_spread).
            if let Some(entries) = known_spread_entries(attr) {
                for (name, val) in entries {
                    let prop = match val {
                        Some(v) => ExplicitProp { value: Some(v), dynamic: false, after_last_spread: i > last_spread },
                        None => dynamic_write(i, last_spread),
                    };
                    explicit.insert(name, prop);
                }
            }
            continue;
        }
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

/// Remap an env keyed by EXTERNAL prop name (`constFold` / `narrow`) to one keyed
/// by the LOCAL binding name each prop introduces.  Call-site analysis and
/// call-site attribute dropping work off the external name (`prop` in `prop:
/// alias`), but every body/template reference uses the local name (`alias`), so
/// substitution, branch folding and CSS must look values up by local.  A prop in
/// `constFold`/`narrow` always has a single-identifier local by construction
/// (`build_plan` never folds a `None`-local or shadowed prop), so every entry maps
/// cleanly; an external name with no matching declared local is dropped.  Mirrors
/// `remapToLocalNames` in analyze.ts.
fn remap_to_local_names<V: Clone>(map: &HashMap<String, V>, model: &Model) -> HashMap<String, V> {
    if map.is_empty() {
        return map.clone(); // common case: nothing folds
    }
    let mut local_by_name: HashMap<&str, &str> = HashMap::new();
    if let Some(pi) = &model.props_info {
        for decl in &pi.props {
            if let Some(local) = &decl.local {
                local_by_name.insert(&decl.name, local);
            }
        }
    }
    let mut out = HashMap::new();
    for (name, value) in map {
        if let Some(local) = local_by_name.get(name.as_str()) {
            out.insert((*local).to_string(), value.clone());
        }
    }
    out
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
        // A `None` local is a nested-pattern entry (`prop: { x }`): there is no
        // single identifier to substitute or drop, so it is never foldable.  The
        // shadow guard tests the LOCAL name (the entity the body references): a
        // name also bound elsewhere is a different entity, so folding it corrupts
        // that binding.  L2 specialization honors the SAME two predicates (mono.ts).
        // Value sets and const_fold/narrow stay keyed by the EXTERNAL name below.
        match &decl.local {
            Some(local) if !is_fold_blocked(model, local) => {}
            _ => continue,
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
    imports: HashMap<String, String>, // tag name -> childId (all edge kinds), for call-site edits
    props_info: Option<PropsInfo>,
    shadowed: HashSet<String>,
    debug: HashSet<String>,
    /// (childId, the `<Child/>` Component node) for every rendered child.
    child_calls: Vec<(String, Value)>,
    escaped: Vec<String>,
    bail_reasons: Vec<String>,
}

fn build_model_full(id: &str, ast: Value, edges: &[Value]) -> Model {
    let imports = edge_imports(&Value::Array(edges.to_vec()));
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
    let escaped = escaped_components(&ast, &imports, &imported, &namespace_locals(&ast));
    Model {
        id: id.to_string(),
        ast,
        imports,
        props_info,
        shadowed: shadowed_vec.into_iter().collect(),
        debug: debug_vec.into_iter().collect(),
        child_calls,
        escaped,
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
        // Dead spans are derived from the TEMPLATE, which references props by their
        // LOCAL binding name — so the fold/narrow envs (keyed by external prop name)
        // must be remapped here.  This MUST match the transform's own remap exactly,
        // or the fixpoint and the edit could disagree on what folds (unsound).
        let env = remap_to_local_names(&plan.const_env(), model);
        let set_env = remap_to_local_names(&plan.set_env(), model);
        let spans = compute_dead_spans(get(&model.ast, "fragment"), &env, &set_env);
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

    // Program-wide escape bail (analyze.ts §4.1).
    let mut escaped = HashSet::new();
    for m in &models {
        for id in &m.escaped {
            escaped.insert(id.clone());
        }
    }
    for m in &mut models {
        if escaped.contains(&m.id) && !m.bail_reasons.iter().any(|r| r == ESCAPE_REASON) {
            m.bail_reasons.push(ESCAPE_REASON.to_string());
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
    // TS type-member name (`interface Props { NAME?: T }` / a `{ NAME: T }` type
    // literal / a method signature): the key is a member NAME in a type position,
    // not a value read of a prop, so folding a same-named prop's literal into it
    // would corrupt the type (`width?: number` -> `36?: number`). Mirror of the TS
    // engine's `isNonReference` guard.
    if (str_eq(p, "type", "TSPropertySignature") || str_eq(p, "type", "TSMethodSignature"))
        && !bool_field(p, "computed")
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
    let mut refs: Vec<FoldRef> = Vec::new();
    {
        let mut emit = |r: FoldRef, _node: &Value| refs.push(r);
        for root in roots {
            collect_fold_refs(root, env, edits, &mut emit);
        }
    }
    if refs.is_empty() {
        return edits.slice(from as usize, to as usize);
    }
    refs.sort_by_key(|r| r.start);
    let mut out = String::new();
    let mut cursor = from;
    for r in refs {
        out.push_str(&edits.slice(cursor as usize, r.start as usize));
        out.push_str(&r.head);
        out.push_str(&env[&r.name].to_source());
        out.push_str(&r.tail);
        cursor = r.end;
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

/// A text node whose source is entirely whitespace.
fn is_whitespace_text(node: &Value, edits: &MagicEdit) -> bool {
    type_of(node) == Some("Text")
        && edits.slice(off(node, "start") as usize, off(node, "end") as usize).trim().is_empty()
}

/// A sibling that adjacent whitespace can "lean on" so it renders a space.  A
/// whitespace-only text node is the seam whitespace itself, and a `Comment` is
/// transparent to SSR (acts as a fragment edge) — neither is a rendering neighbour.
fn is_rendering_sibling(node: &Value, edits: &MagicEdit) -> bool {
    type_of(node) != Some("Comment") && !is_whitespace_text(node, edits)
}

/// An element inside which Svelte preserves whitespace verbatim.
fn is_preserve_element(node: &Value) -> bool {
    type_of(node) == Some("RegularElement")
        && matches!(node.get("name").and_then(Value::as_str), Some("pre") | Some("textarea"))
}

/// Node types that reset the content-model parent to "unknown" (text allowed
/// again), mirroring svelte's `parent_element: null` reset in the SvelteElement /
/// SvelteFragment / SnippetBlock / Component visitors.  See transform.ts
/// `PARENT_ELEMENT_RESET`.
fn is_parent_element_reset(node: &Value) -> bool {
    matches!(
        type_of(node),
        Some("SvelteElement") | Some("SvelteFragment") | Some("SnippetBlock") | Some("Component") | Some("SvelteSelf") | Some("SvelteComponent")
    )
}

/// The content-model parent element a seam would land in for `node`'s children,
/// given the element the walk is currently inside.  Mirrors svelte's
/// `parent_element` threading: a `RegularElement` becomes the parent, the reset
/// node types clear it, every other node (Fragment, blocks, …) inherits.  `None`
/// means "text allowed" (root or a reset context).  See transform.ts
/// `childParentElement`.
fn child_parent_element<'a>(node: &'a Value, current: Option<&'a str>) -> Option<&'a str> {
    if type_of(node) == Some("RegularElement") {
        return node.get("name").and_then(Value::as_str);
    }
    if is_parent_element_reset(node) {
        return None;
    }
    current
}

/// True when an `{" "}` seam would be an invalid text child of `element`: these are
/// svelte's `disallowed_children` entries carrying an `only` list (text is in none
/// of them), restricted to the parts that can appear as elements inside a
/// component.  See transform.ts `TEXT_FREE_PARENTS` / `isTextFreeParent`.
fn is_text_free_parent(element: Option<&str>) -> bool {
    matches!(element, Some("table" | "thead" | "tbody" | "tfoot" | "tr" | "colgroup"))
}

/// True when an attribute value is the literal `{false}` (or `false`).
fn attr_is_explicit_false(value: &Value) -> bool {
    if value == &Value::Bool(false) {
        return true;
    }
    let parts: Vec<&Value> = match value {
        Value::Array(a) => a.iter().collect(),
        _ => vec![value],
    };
    parts.iter().any(|p| {
        type_of(p) == Some("ExpressionTag")
            && type_of(get(p, "expression")) == Some("Literal")
            && get(p, "expression").get("value") == Some(&Value::Bool(false))
    })
}

/// Does the component opt into preserved whitespace via `<svelte:options>`?
fn has_preserve_whitespace_option(fragment: &Value) -> bool {
    let mut preserve = false;
    walk(fragment, &mut |node| {
        if type_of(node) == Some("SvelteOptions") {
            for a in arr(node, "attributes") {
                if str_eq(a, "type", "Attribute")
                    && a.get("name").and_then(Value::as_str) == Some("preserveWhitespace")
                {
                    preserve = !attr_is_explicit_false(get(a, "value"));
                }
            }
        }
    });
    preserve
}

/// True when a chain folds away entirely (its whole span is the only removal).
fn is_full_removal(decision: &ChainDecision) -> bool {
    decision.kept.is_none() && decision.removed.len() == 1 && decision.removed[0] == decision.span
}

/// Decide whether removing the chain at `siblings[index]` loses a separating
/// space, returning the `[from, to]` span (covering the adjacent whitespace-only
/// siblings plus the chain) to overwrite with `{" "}` if so.  See transform.ts
/// `analyzeSeam` for the `origSpace`/`afterSpace` derivation.
fn analyze_seam(siblings: &[Value], index: usize, span: Span, edits: &MagicEdit, dead: &[Span]) -> Option<Span> {
    let live = |node: &Value| !in_spans(node, dead);
    let left = if index >= 1 { siblings.get(index - 1) } else { None };
    let l = left.filter(|n| live(n) && is_whitespace_text(n, edits));
    let r = siblings.get(index + 1).filter(|n| live(n) && is_whitespace_text(n, edits));

    let p_idx = if l.is_some() { index as isize - 2 } else { index as isize - 1 };
    let n_idx = if r.is_some() { index + 2 } else { index + 1 };
    let p = p_idx >= 0 && siblings.get(p_idx as usize).is_some_and(|n| is_rendering_sibling(n, edits));
    let n = siblings.get(n_idx).is_some_and(|node| is_rendering_sibling(node, edits));

    let orig_space = (l.is_some() && p) || (r.is_some() && n);
    let after_space = p && n && (l.is_some() || r.is_some());
    if !orig_space || after_space {
        return None;
    }
    Some((l.map_or(span.0, |n| off(n, "start")), r.map_or(span.1, |n| off(n, "end"))))
}

/// Delete a chain that renders nothing, compensating the seam (see transform.ts
/// `removeChain`) so the rendered whitespace is unchanged.
fn remove_chain(
    removed: &[Span],
    span: Span,
    edits: &mut MagicEdit,
    dead: &mut Vec<Span>,
    siblings: Option<&[Value]>,
    index: usize,
    preserve: bool,
    element: Option<&str>,
) {
    // Never compensate under preserved whitespace (plain deletion is byte-exact)
    // nor inside a text-free parent (`<tr>`, `<tbody>`, …), where Svelte rejects the
    // `{" "}` text child and the whitespace rendered nothing to begin with.
    if !preserve && !is_text_free_parent(element) {
        if let Some(sibs) = siblings {
            if let Some(seam) = analyze_seam(sibs, index, span, edits, dead) {
                edits.overwrite(seam.0 as usize, seam.1 as usize, "{\" \"}");
                dead.push(seam);
                return;
            }
        }
    }
    for (a, b) in removed {
        edits.remove(*a as usize, *b as usize);
        dead.push((*a, *b));
    }
}

fn apply_chain(
    decision: &ChainDecision,
    env: &Env,
    edits: &mut MagicEdit,
    dead: &mut Vec<Span>,
    siblings: Option<&[Value]>,
    index: usize,
    preserve: bool,
    element: Option<&str>,
) {
    if let Some(frag) = &decision.kept {
        let mut text = fragment_source(edits, frag, env);
        // Strip the kept arm's leading/trailing whitespace (block-fragment edges,
        // trimmed in the original) so splicing it inline does not gain a space.
        if !preserve {
            text = text.trim().to_string();
        }
        // A kept arm that renders nothing behaves like a full removal.
        if text.is_empty() && !preserve {
            remove_chain(&[decision.span], decision.span, edits, dead, siblings, index, preserve, element);
            return;
        }
        edits.overwrite(decision.span.0 as usize, decision.span.1 as usize, &text);
        dead.push(decision.span);
        return;
    }
    if is_full_removal(decision) {
        remove_chain(&decision.removed, decision.span, edits, dead, siblings, index, preserve, element);
        return;
    }
    for (a, b) in &decision.removed {
        edits.remove(*a as usize, *b as usize);
        dead.push((*a, *b));
    }
    if let Some((from, to, text)) = &decision.header_rewrite {
        edits.overwrite(*from as usize, *to as usize, text);
    }
}

fn fold_if_blocks<'a>(
    node: &'a Value,
    env: &Env,
    set_env: &SetEnv,
    edits: &mut MagicEdit,
    dead: &mut Vec<Span>,
    siblings: Option<&'a [Value]>,
    index: usize,
    preserve: bool,
    element: Option<&'a str>,
) {
    match node {
        Value::Array(items) => {
            for (i, v) in items.iter().enumerate() {
                fold_if_blocks(v, env, set_env, edits, dead, Some(items), i, preserve, element);
            }
        }
        Value::Object(map) => {
            if type_of(node) == Some("IfBlock") {
                if node.get("elseif") == Some(&Value::Bool(true)) || in_spans(node, dead) {
                    return;
                }
                let decision = decide_chain(node, env, set_env);
                apply_chain(&decision, env, edits, dead, siblings, index, preserve, element);
                if decision.recurse {
                    // kept head: the `{#if}` is transparent to the content model, so its
                    // children stay in the same parent element.
                    for v in map.values() {
                        fold_if_blocks(v, env, set_env, edits, dead, None, 0, preserve, element);
                    }
                }
                return;
            }
            let child_preserve = preserve || is_preserve_element(node);
            let child_element = child_parent_element(node, element);
            for v in map.values() {
                fold_if_blocks(v, env, set_env, edits, dead, None, 0, child_preserve, child_element);
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

/// One folded-prop edit: overwrite `[start,end)` with `head + <literal> + tail`.
/// A plain read has empty head/tail and the identifier's own span; a SHORTHAND
/// position wraps the literal back into explicit `name={…}` form (see
/// `fold_ref_for` / `collect_fold_refs`).  Mirrors `FoldRef` in transform.ts.
struct FoldRef {
    start: i64,
    end: i64,
    head: String,
    tail: String,
    name: String,
}

/// `collectFoldRefs`: visit every folded-prop reference in `root` — plain reads,
/// the `class:`/`{…}` shorthands `fold_ref_for` expands, and `style:NAME`
/// shorthands (no expression node) — calling `emit` with each edit and its node
/// (so callers can filter on position).  Shared by the live pass and
/// `substituted_slice` so both fold shorthands identically.
fn collect_fold_refs<F: FnMut(FoldRef, &Value)>(root: &Value, env: &Env, edits: &MagicEdit, emit: &mut F) {
    walk_grandparented(root, None, None, &mut |node, parent, grandparent| {
        // `style:NAME` shorthand carries no expression node (its `value` is the
        // boolean `true` marker); expand it to `style:NAME={lit}` or the dropped
        // prop dangles.  Trim trailing whitespace some parsers fold into `end`.
        if str_eq(node, "type", "StyleDirective") && node.get("value") == Some(&Value::Bool(true)) {
            if let Some(name) = node.get("name").and_then(Value::as_str) {
                if env.contains_key(name) {
                    let start = off(node, "start");
                    let mut end = off(node, "end");
                    while end > start && edits.unit_at((end - 1) as usize).map(is_ws_u16) == Some(true) {
                        end -= 1;
                    }
                    let src = edits.slice(start as usize, end as usize); // `style:NAME`
                    emit(
                        FoldRef { start, end, head: format!("{src}={{"), tail: "}".to_string(), name: name.to_string() },
                        node,
                    );
                }
            }
        } else if str_eq(node, "type", "Identifier") {
            if let Some(name) = node.get("name").and_then(Value::as_str) {
                if env.contains_key(name) && !is_non_reference(node, parent) {
                    emit(fold_ref_for(node, parent, grandparent, edits, name), node);
                }
            }
        }
    });
}

/// `foldRefFor`: the edit to substitute a folded prop at `node`.  A plain read
/// overwrites just the identifier; a SHORTHAND position expands to the explicit
/// `name={value}` form (`class:compact` -> `class:compact={false}`, `{compact}`
/// -> `compact={false}`) so the rewrite stays valid Svelte.
fn fold_ref_for(node: &Value, parent: Option<&Value>, grandparent: Option<&Value>, edits: &MagicEdit, name: &str) -> FoldRef {
    let start = off(node, "start");
    let end = off(node, "end");
    // `class:NAME` shorthand: the identifier sits in the directive-name slot, right
    // after the `:` (the long form puts it inside `={…}`, where the char is `{`).
    if let Some(p) = parent {
        if str_eq(p, "type", "ClassDirective")
            && same_node(get(p, "expression"), node)
            && start > 0
            && edits.unit_at((start - 1) as usize) == Some(b':' as u16)
        {
            return FoldRef { start, end, head: format!("{name}={{"), tail: "}".to_string(), name: name.to_string() };
        }
    }
    // `{NAME}` attribute shorthand: the braces belong to the Attribute, not the
    // ExpressionTag, so overwrite the whole attribute (`{NAME}` -> `NAME={lit}`).
    if let (Some(p), Some(gp)) = (parent, grandparent) {
        if str_eq(p, "type", "ExpressionTag")
            && str_eq(gp, "type", "Attribute")
            && edits.unit_at(off(gp, "start") as usize) == Some(b'{' as u16)
        {
            if let Some(attr_name) = gp.get("name").and_then(Value::as_str) {
                return FoldRef {
                    start: off(gp, "start"),
                    end: off(gp, "end"),
                    head: format!("{attr_name}={{"),
                    tail: "}".to_string(),
                    name: name.to_string(),
                };
            }
        }
    }
    // Object shorthand `{ NAME }`: a `Property` with `shorthand: true` whose single
    // identifier is BOTH key and value.  Expand to `NAME: lit` (a plain replace would
    // yield `{ "lit" }`, invalid).
    if let Some(p) = parent {
        if str_eq(p, "type", "Property")
            && p.get("shorthand") == Some(&Value::Bool(true))
            && same_node(get(p, "value"), node)
        {
            return FoldRef {
                start,
                end,
                head: format!("{name}: "),
                tail: String::new(),
                name: name.to_string(),
            };
        }
    }
    FoldRef { start, end, head: String::new(), tail: String::new(), name: name.to_string() }
}

fn collect_prop_refs(model: &Model, env: &Env, dead: &[Span], edits: &MagicEdit) -> Vec<FoldRef> {
    let mut refs = Vec::new();
    {
        let mut emit = |r: FoldRef, node: &Value| {
            if !in_spans(node, dead) {
                refs.push(r);
            }
        };
        collect_fold_refs(get(&model.ast, "instance"), env, edits, &mut emit);
        collect_fold_refs(get(&model.ast, "fragment"), env, edits, &mut emit);
    }
    refs
}

/// Delete the run of dropped destructuring properties `properties[lo..=hi]` together,
/// absorbing the commas/whitespace so the result stays valid: eat forward to the next
/// survivor when one follows; otherwise the run reaches the end, so include a trailing
/// comma (but not the whitespace before `}`) and reach back to the previous survivor.
fn remove_property_run(properties: &[Value], lo: usize, hi: usize, edits: &mut MagicEdit) {
    let first = &properties[lo];
    let last = &properties[hi];
    if let Some(kept_after) = properties.get(hi + 1) {
        edits.remove(off(first, "start") as usize, off(kept_after, "start") as usize);
        return;
    }
    let mut end = off(last, "end") as usize;
    let len = edits.len();
    let mut j = end;
    while j < len && edits.unit_at(j).map(is_ws_u16) == Some(true) {
        j += 1;
    }
    if edits.unit_at(j) == Some(b',' as u16) {
        end = j + 1;
    }
    let start = if lo > 0 {
        off(&properties[lo - 1], "end") as usize
    } else {
        off(first, "start") as usize
    };
    edits.remove(start, end);
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
    // Remove each maximal RUN of consecutive dropped properties as one range so the
    // separating commas tile cleanly (a per-property removal mishandles a trailing
    // comma on the last property and overlaps on consecutive drops -> dangling `,`).
    let dropped_flags: Vec<bool> = properties
        .iter()
        .map(|p| pi.props.iter().any(|d| same_node(&d.property, p) && drop.contains(&d.name)))
        .collect();
    let mut i = 0;
    while i < properties.len() {
        if !dropped_flags[i] {
            i += 1;
            continue;
        }
        let mut hi = i;
        while hi + 1 < properties.len() && dropped_flags[hi + 1] {
            hi += 1;
        }
        remove_property_run(properties, i, hi, edits);
        i = hi + 1;
    }
    for decl in &pi.props {
        if drop.contains(&decl.name) {
            remove_type_member(&pi.pattern, &decl.name, edits);
        }
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

fn remove_call_site_attributes(
    model: &Model,
    dropped: &HashMap<String, HashSet<String>>,
    edits: &mut MagicEdit,
    edited_spans: &[Span],
) {
    // Collect first (so we don't borrow the ast through `walk` while editing).
    let mut to_remove: Vec<Value> = Vec::new();
    walk(get(&model.ast, "fragment"), &mut |node| {
        if !str_eq(node, "type", "Component") {
            return;
        }
        // Skip a `<Child/>` phase 1 folded away: its source (attributes included) is
        // gone, so editing it now would overlap that edit.
        if !edited_spans.is_empty() && in_spans(node, edited_spans) {
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
fn shake_body(
    model: &Model,
    env: &Env,
    set_env: &SetEnv,
    edits: &mut MagicEdit,
    out_dead: &mut Vec<Span>,
) -> HashSet<String> {
    if env.is_empty() && set_env.is_empty() {
        return HashSet::new();
    }
    let fragment = get(&model.ast, "fragment");
    // `env`/`set_env` arrive keyed by the EXTERNAL prop name (that is what the plan
    // carries).  Every body/template reference, however, uses the prop's LOCAL
    // binding name (`prop: alias` -> `alias`), and the two can even be different
    // entities (a same-named import).  Remap ONCE to local-keyed envs for every
    // name-matched pass below (branch folding, ternaries, reference substitution,
    // CSS); the `$props()` signature drop keeps the external names.
    let local_env = remap_to_local_names(env, model);
    let local_set_env = remap_to_local_names(set_env, model);
    let mut dead: Vec<Span> = Vec::new();
    fold_if_blocks(fragment, &local_env, &local_set_env, edits, &mut dead, None, 0, has_preserve_whitespace_option(fragment), None);
    if !local_env.is_empty() {
        fold_ternaries(fragment, &local_env, edits, &mut dead);
    }
    for r in collect_prop_refs(model, &local_env, &dead, edits) {
        let text = format!("{}{}{}", r.head, local_env[&r.name].to_source(), r.tail);
        edits.overwrite(r.start as usize, r.end as usize, &text);
    }
    // The drop matches the destructure KEYS, so it keeps the EXTERNAL names (which
    // is also what phase 2's call-site attribute removal consumes).
    let droppable: HashSet<String> = env.keys().cloned().collect();
    drop_props(model, &droppable, edits);
    shake_css(model, &local_env, &local_set_env, edits);
    // Hand phase 2 the regions we edited so it never edits inside a folded-away branch.
    out_dead.extend(dead.iter().copied());
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
    for m in &models {
        escaped.extend(m.escaped.iter().cloned());
    }
    for m in &mut models {
        if escaped.contains(&m.id) && !m.bail_reasons.iter().any(|r| r == ESCAPE_REASON) {
            m.bail_reasons.push(ESCAPE_REASON.to_string());
        }
    }

    let plans = run_fixpoint(&models);

    // Phase 1: fold each body and drop its folded props.
    let mut edits_map: HashMap<String, MagicEdit> = HashMap::new();
    let mut dropped: HashMap<String, HashSet<String>> = HashMap::new();
    let mut edited_spans: HashMap<String, Vec<Span>> = HashMap::new();
    for model in &models {
        let plan = &plans[&model.id];
        let mut edits = MagicEdit::new(code_by_id.get(&model.id).map(String::as_str).unwrap_or(""));
        let mut dead: Vec<Span> = Vec::new();
        let d = if plan.bail {
            HashSet::new()
        } else {
            shake_body(model, &plan.const_env(), &plan.set_env(), &mut edits, &mut dead)
        };
        dropped.insert(model.id.clone(), d);
        edited_spans.insert(model.id.clone(), dead);
        edits_map.insert(model.id.clone(), edits);
    }
    // Phase 2: remove call-site attributes for props the child actually dropped,
    // skipping any call site phase 1 folded away (its attributes went with it).
    for model in &models {
        if let Some(edits) = edits_map.get_mut(&model.id) {
            let empty = Vec::new();
            let spans = edited_spans.get(&model.id).unwrap_or(&empty);
            remove_call_site_attributes(model, &dropped, edits, spans);
        }
    }

    let out: serde_json::Map<String, Value> = models
        .iter()
        .map(|m| (m.id.clone(), Value::String(edits_map.get(&m.id).map(|e| e.render()).unwrap_or_default())))
        .collect();
    Value::Object(out).to_string()
}

// ======================================================================
// L2 per-call-site monomorphization — the Rust port of mono.ts + the call-site
// rewrite in transform.ts.  The graph/gate logic is native and reuses the
// L0/L1/L1.5 substrate (shake_body, compute_dead_spans, read_call_site,
// dead_spans_for_plans), so the ONLY thing crossing back to JS is the per-module
// size proxy `ownSize` (svelte compile), passed as a callback.  Using the SAME
// compiler the TS engine uses makes every decision byte-identical; validated by
// the differential `wasm-mono` test (Rust files+variants == TS svelteShakerWithMono).
// ======================================================================

struct MonoOptions {
    enabled: bool,
    max_variants: usize,
    min_savings: f64,
}

/// One live `<Child/>` site that folds extra literals (a specialization candidate).
struct MonoCandidate {
    owner: String,
    node: Value,
    shape: Vec<(String, Literal)>,
    /// The residual this site folds to — the dedup key.
    code: String,
}

struct MonoBinding {
    owner: String,
    node: Value,
    /// `<childId>?shaker_variant=<n>` request specifier this site resolves to.
    variant_spec: String,
    shape: Vec<(String, Literal)>,
}

/// `<childId>?shaker_variant=<n>` — the request a rewritten call site imports a
/// variant from (mirrors vite.ts `variantSpecifier`, the `::v` form flattened).
fn variant_specifier(child_id: &str, n: usize) -> String {
    format!("{}?shaker_variant={}", child_id, n)
}

/// `<childId>::v<n>` — the variant's stable id, used ONLY as the `filename` the
/// net-win gate sizes it under (mirrors mono.ts `Variant.id`).  The Svelte
/// compiler derives the component function name from the filename, so the gate
/// must size each variant under this exact id to match the TS engine byte-for-byte.
fn variant_id(child_id: &str, n: usize) -> String {
    format!("{}::v{}", child_id, n)
}

/// (env, set_env) for a child's L1 constants PLUS a call site's extra literals;
/// a prop frozen by `extra`/constFold is a constant, so it leaves the narrow set.
fn env_with_extra(plan: &ComponentPlan, extra: &[(String, Literal)]) -> (Env, SetEnv) {
    let mut env: Env = plan.const_env();
    for (k, v) in extra {
        env.insert(k.clone(), v.clone());
    }
    let mut set_env: SetEnv = HashMap::new();
    for (k, v) in &plan.narrow {
        if !env.contains_key(k) {
            set_env.insert(k.clone(), v.clone());
        }
    }
    (env, set_env)
}

/// The residual source for a child under an augmented fold environment — the SAME
/// L0/L1/L1.5 pipeline (`shake_body`) the whole-program transform uses.  Mirrors
/// `renderResidual`; `extra = []` yields the base residual.
fn render_residual(child: &Model, plan: &ComponentPlan, code: &str, extra: &[(String, Literal)]) -> String {
    let (env, set_env) = env_with_extra(plan, extra);
    let mut edits = MagicEdit::new(code);
    let mut dead = Vec::new();
    shake_body(child, &env, &set_env, &mut edits, &mut dead);
    edits.render()
}

/// The live child component ids a residual renders, WITHOUT re-parsing it: a
/// `<Child/>` survives iff its node is not inside a dead `{#if}` span for this
/// fold environment.  Equivalent to mono.ts `liveChildIds(residual)` (the
/// residual is the base with dead-span regions removed), but needs no parser —
/// which the engine does not have in Rust.
fn live_children_for_env(model: &Model, env: &Env, set_env: &SetEnv) -> Vec<String> {
    let local_env = remap_to_local_names(env, model);
    let local_set = remap_to_local_names(set_env, model);
    let dead = compute_dead_spans(get(&model.ast, "fragment"), &local_env, &local_set);
    let mut out = Vec::new();
    for (cid, node) in &model.child_calls {
        if !dead.is_empty() && in_spans(node, &dead) {
            continue;
        }
        out.push(cid.clone());
    }
    out
}

/// The extra props a call site freezes to a literal (declared, not already an
/// app-wide constant, not shadowed/`{@debug}`/nested, literal & no spread can
/// override).  Mirrors `specializableShape`.
fn specializable_shape(node: &Value, child: &Model, plan: &ComponentPlan) -> Vec<(String, Literal)> {
    let site = read_call_site(node);
    let mut declared: HashMap<&str, &PropDecl> = HashMap::new();
    if let Some(pi) = &child.props_info {
        for d in &pi.props {
            declared.insert(d.name.as_str(), d);
        }
    }
    let const_keys: HashSet<&str> = plan.const_fold.iter().map(|(k, _)| k.as_str()).collect();
    let mut shape: Vec<(String, Literal)> = Vec::new();
    for (name, explicit) in &site.explicit {
        let decl = match declared.get(name.as_str()) {
            Some(d) => *d,
            None => continue, // undeclared -> flows to `...rest`
        };
        if const_keys.contains(name.as_str()) {
            continue; // already an app-wide L1 constant
        }
        let local = match &decl.local {
            Some(l) => l,
            None => continue, // nested pattern -> unfoldable
        };
        if is_fold_blocked(child, local) {
            continue;
        }
        if explicit.dynamic || !explicit.after_last_spread {
            continue; // not a literal a spread cannot override
        }
        if let Some(v) = &explicit.value {
            shape.push((name.clone(), v.clone()));
        }
    }
    shape
}

/// The measured net-win gate (the optimized, diff-only form): specialize iff
/// replacing the child with its variants strictly shrinks the module bytes
/// reachable from `roots`.  Only the modules whose size differs between the base
/// and spec scenarios are sized (the rest cancel for `min_savings == 0`).
#[allow(clippy::too_many_arguments)]
fn net_win(
    child_id: &str,
    // (variant id `<childId>::v<n>`, residual code) — the id is the sizing filename.
    variant_specs: &[(String, String)],
    variant_children: &HashMap<String, Vec<String>>,
    base_source: &HashMap<String, String>,
    base_children_of: &HashMap<String, Vec<String>>,
    roots: &[String],
    own_size: &mut dyn FnMut(&str, &str) -> Option<f64>,
    min_savings: f64,
) -> bool {
    // BASE reachability (graph only).
    let mut base_reached: HashSet<String> = HashSet::new();
    let mut stack: Vec<String> = roots.to_vec();
    while let Some(id) = stack.pop() {
        if !base_reached.insert(id.clone()) {
            continue;
        }
        if let Some(ch) = base_children_of.get(&id) {
            for c in ch {
                stack.push(c.clone());
            }
        }
    }

    // SPEC reachability: the child's incoming edges redirect to all its variants.
    let all_specs: Vec<String> = variant_specs.iter().map(|(s, _)| s.clone()).collect();
    let mut spec_components: HashSet<String> = HashSet::new();
    let mut spec_variants: HashSet<String> = HashSet::new();
    let mut comp_stack: Vec<String> = Vec::new();
    let mut var_stack: Vec<String> = Vec::new();
    for r in roots {
        if r == child_id {
            var_stack.extend(all_specs.iter().cloned());
        } else {
            comp_stack.push(r.clone());
        }
    }
    while !comp_stack.is_empty() || !var_stack.is_empty() {
        if let Some(id) = comp_stack.pop() {
            if !spec_components.insert(id.clone()) {
                continue;
            }
            if let Some(ch) = base_children_of.get(&id) {
                for c in ch {
                    if c == child_id {
                        var_stack.extend(all_specs.iter().cloned());
                    } else {
                        comp_stack.push(c.clone());
                    }
                }
            }
            continue;
        }
        let vid = var_stack.pop().unwrap();
        if !spec_variants.insert(vid.clone()) {
            continue;
        }
        if let Some(ch) = variant_children.get(&vid) {
            for c in ch {
                if c == child_id {
                    var_stack.extend(all_specs.iter().cloned());
                } else {
                    comp_stack.push(c.clone());
                }
            }
        }
    }

    // Size only the symmetric difference.  Each module is sized under its own id as
    // the compiler `filename` (the Svelte function name derives from it).
    let mut base_side = 0f64;
    let mut spec_side = 0f64;
    for id in &base_reached {
        if spec_components.contains(id) {
            continue; // shared -> cancels
        }
        match own_size(id, base_source.get(id).map(String::as_str).unwrap_or("")) {
            Some(s) => base_side += s,
            None => return false,
        }
    }
    for (vid, code) in variant_specs {
        if !spec_variants.contains(vid) {
            continue;
        }
        match own_size(vid, code) {
            Some(s) => spec_side += s,
            None => return false,
        }
    }
    for id in &spec_components {
        if base_reached.contains(id) {
            continue; // folding never adds reachability; defensive
        }
        match own_size(id, base_source.get(id).map(String::as_str).unwrap_or("")) {
            Some(s) => spec_side += s,
            None => return false,
        }
    }

    if min_savings == 0.0 {
        return spec_side < base_side;
    }
    let mut shared = 0f64;
    for id in &base_reached {
        if !spec_components.contains(id) {
            continue;
        }
        match own_size(id, base_source.get(id).map(String::as_str).unwrap_or("")) {
            Some(s) => shared += s,
            None => return false,
        }
    }
    spec_side + shared < (base_side + shared) * (1.0 - min_savings)
}

/// Compute the L2 variants + call-site bindings.  Mirrors `monomorphize` in
/// mono.ts; pure over models/plans except the JS `own_size` callback.
fn monomorphize(
    models: &[Model],
    plans: &Plans,
    code_by_id: &HashMap<String, String>,
    entries: &[String],
    opts: &MonoOptions,
    own_size: &mut dyn FnMut(&str, &str) -> Option<f64>,
) -> (Vec<(String, String)>, Vec<MonoBinding>) {
    let mut variants: Vec<(String, String)> = Vec::new();
    let mut bindings: Vec<MonoBinding> = Vec::new();
    if !opts.enabled {
        return (variants, bindings);
    }

    let models_by_id: HashMap<&str, &Model> = models.iter().map(|m| (m.id.as_str(), m)).collect();
    let dead_spans = dead_spans_for_plans(models, plans);

    // base residual + base render graph (computed once for all candidates).
    let mut base_source: HashMap<String, String> = HashMap::new();
    let mut base_children_of: HashMap<String, Vec<String>> = HashMap::new();
    for m in models {
        let plan = &plans[&m.id];
        let code = code_by_id.get(&m.id).map(String::as_str).unwrap_or("");
        if plan.bail {
            base_source.insert(m.id.clone(), code.to_string());
            base_children_of.insert(m.id.clone(), m.child_calls.iter().map(|(c, _)| c.clone()).collect());
        } else {
            base_source.insert(m.id.clone(), render_residual(m, plan, code, &[]));
            base_children_of.insert(m.id.clone(), live_children_for_env(m, &plan.const_env(), &plan.set_env()));
        }
    }

    // (1) gather, per child, every live site that folds a non-base residual.
    let mut child_order: Vec<String> = Vec::new();
    let mut live_sites: HashMap<String, Vec<MonoCandidate>> = HashMap::new();
    let mut ineligible: HashSet<String> = HashSet::new();
    for owner in models {
        let empty = Vec::new();
        let dead = dead_spans.get(&owner.id).unwrap_or(&empty);
        for (child_id, node) in &owner.child_calls {
            if !dead.is_empty() && in_spans(node, dead) {
                continue; // dead site
            }
            let child = match models_by_id.get(child_id.as_str()) {
                Some(c) => *c,
                None => continue,
            };
            let child_plan = match plans.get(child_id) {
                Some(p) => p,
                None => continue,
            };
            let no_props = child.props_info.as_ref().map(|p| p.props.is_empty()).unwrap_or(true);
            if child_plan.bail || no_props {
                ineligible.insert(child_id.clone());
                continue;
            }
            let shape = specializable_shape(node, child, child_plan);
            if shape.is_empty() {
                ineligible.insert(child_id.clone());
                continue;
            }
            let code = render_residual(
                child,
                child_plan,
                code_by_id.get(child_id).map(String::as_str).unwrap_or(""),
                &shape,
            );
            if base_source.get(child_id).map(|b| b == &code).unwrap_or(false) {
                ineligible.insert(child_id.clone());
                continue;
            }
            if !live_sites.contains_key(child_id) {
                child_order.push(child_id.clone());
            }
            live_sites.entry(child_id.clone()).or_default().push(MonoCandidate {
                owner: owner.id.clone(),
                node: node.clone(),
                shape,
                code,
            });
        }
    }

    // Reachability roots = entries not rendered by anyone (true import roots).
    let mut incoming: HashSet<&String> = HashSet::new();
    for ids in base_children_of.values() {
        for c in ids {
            incoming.insert(c);
        }
    }
    let roots: Vec<String> = entries
        .iter()
        .filter(|e| models_by_id.contains_key(e.as_str()) && !incoming.contains(e))
        .cloned()
        .collect();

    let candidate_children: HashSet<String> =
        child_order.iter().filter(|c| !ineligible.contains(*c)).cloned().collect();

    // (3) decide each candidate child against the base scenario.
    for child_id in &child_order {
        if ineligible.contains(child_id) {
            continue;
        }
        let sites = &live_sites[child_id];
        // A live-site owner is itself a candidate -> declining avoids base+variant
        // bloat (nested specialization is a documented followup).
        if sites.iter().any(|s| &s.owner != child_id && candidate_children.contains(&s.owner)) {
            continue;
        }
        // Dedup residuals into the variant set, capped by maxVariants.  Each variant
        // is keyed for the net-win gate by its id (`<childId>::v<n>`, the sizing
        // filename) and emitted to the Shell by its specifier (`?shaker_variant=n`).
        let mut residual_to_n: HashMap<String, usize> = HashMap::new();
        let mut nw_variants: Vec<(String, String)> = Vec::new(); // (variant id, code)
        let mut nw_children: HashMap<String, Vec<String>> = HashMap::new();
        let child_model = models_by_id[child_id.as_str()];
        let child_plan = &plans[child_id];
        let mut over_cap = false;
        for site in sites {
            if residual_to_n.contains_key(&site.code) {
                continue;
            }
            if nw_variants.len() >= opts.max_variants {
                over_cap = true;
                break;
            }
            let n = nw_variants.len();
            residual_to_n.insert(site.code.clone(), n);
            let vid = variant_id(child_id, n);
            let (env, set_env) = env_with_extra(child_plan, &site.shape);
            nw_children.insert(vid.clone(), live_children_for_env(child_model, &env, &set_env));
            nw_variants.push((vid, site.code.clone()));
        }
        if over_cap {
            continue;
        }
        if !net_win(
            child_id,
            &nw_variants,
            &nw_children,
            &base_source,
            &base_children_of,
            &roots,
            own_size,
            opts.min_savings,
        ) {
            continue;
        }
        // Emit variants (keyed by specifier) + bind every live site.
        for (n, (_vid, code)) in nw_variants.iter().enumerate() {
            variants.push((variant_specifier(child_id, n), code.clone()));
        }
        for site in sites {
            let n = residual_to_n[&site.code];
            bindings.push(MonoBinding {
                owner: site.owner.clone(),
                node: site.node.clone(),
                variant_spec: variant_specifier(child_id, n),
                shape: site.shape.clone(),
            });
        }
    }

    (variants, bindings)
}

/// Rewrite each bound `<Child …>` site to import + render a specialized variant,
/// stripping the frozen-prop attributes.  Mirrors `rewriteBoundCallSites`.
fn rewrite_bound_call_sites(
    models_by_id: &HashMap<&str, &Model>,
    bindings: &[MonoBinding],
    code_by_id: &HashMap<String, String>,
    edits_map: &mut HashMap<String, MagicEdit>,
) {
    let mut owner_order: Vec<String> = Vec::new();
    let mut by_owner: HashMap<String, Vec<&MonoBinding>> = HashMap::new();
    for b in bindings {
        if !by_owner.contains_key(&b.owner) {
            owner_order.push(b.owner.clone());
        }
        by_owner.entry(b.owner.clone()).or_default().push(b);
    }
    for owner_id in &owner_order {
        let model = match models_by_id.get(owner_id.as_str()) {
            Some(m) => *m,
            None => continue,
        };
        let code = match code_by_id.get(owner_id) {
            Some(c) => c.as_str(),
            None => continue,
        };
        let edits = match edits_map.get_mut(owner_id) {
            Some(e) => e,
            None => continue,
        };
        let list = &by_owner[owner_id];
        let mut local_for: HashMap<String, String> = HashMap::new();
        let mut imports_to_add: Vec<(String, String)> = Vec::new();
        let mut counter = 0usize;
        for b in list {
            let original = b.node.get("name").and_then(Value::as_str).unwrap_or("Cmp");
            let local = match local_for.get(&b.variant_spec) {
                Some(l) => l.clone(),
                None => {
                    let l = format!("{}__shaker_v{}", original, counter);
                    counter += 1;
                    local_for.insert(b.variant_spec.clone(), l.clone());
                    imports_to_add.push((l.clone(), b.variant_spec.clone()));
                    l
                }
            };
            rewrite_one_site(code, &b.node, &local, &b.shape, edits);
        }
        if !imports_to_add.is_empty() {
            inject_imports(model, &imports_to_add, edits);
        }
    }
}

/// The greatest `p <= from` with `haystack[p..p+needle.len()] == needle`
/// (UTF-16 units) — the `String.prototype.lastIndexOf(needle, from)` analog.
fn rfind_u16(haystack: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    let max_start = from.min(haystack.len() - needle.len());
    let mut p = max_start as isize;
    while p >= 0 {
        let i = p as usize;
        if &haystack[i..i + needle.len()] == needle {
            return Some(i);
        }
        p -= 1;
    }
    None
}

/// Rewrite one `<Child …>` open (and matching close) tag name to `local` and strip
/// the frozen-prop attributes.  Mirrors `rewriteOneSite`; offsets are UTF-16 units.
fn rewrite_one_site(code: &str, node: &Value, local: &str, frozen: &[(String, Literal)], edits: &mut MagicEdit) {
    let name = match node.get("name").and_then(Value::as_str) {
        Some(n) => n,
        None => return,
    };
    let units: Vec<u16> = code.encode_utf16().collect();
    let name_u: Vec<u16> = name.encode_utf16().collect();
    let start = off(node, "start") as usize;
    let end = off(node, "end") as usize;

    let open_name_start = start + 1;
    if open_name_start + name_u.len() <= units.len()
        && units[open_name_start..open_name_start + name_u.len()] == name_u[..]
    {
        edits.overwrite(open_name_start, open_name_start + name_u.len(), local);
    }
    // `</name` — the last occurrence at or before node.end (this element's own close).
    let marker: Vec<u16> = format!("</{}", name).encode_utf16().collect();
    if let Some(close_idx) = rfind_u16(&units, &marker, end.min(units.len())) {
        if close_idx >= start {
            let from = close_idx + 2; // skip `</`
            edits.overwrite(from, from + name_u.len(), local);
        }
    }
    // Remove the frozen-prop attributes (the variant hard-codes them).
    let frozen_names: HashSet<&str> = frozen.iter().map(|(k, _)| k.as_str()).collect();
    for attr in arr(node, "attributes") {
        if type_of(attr) != Some("Attribute") {
            continue;
        }
        let an = match attr.get("name").and_then(Value::as_str) {
            Some(a) => a,
            None => continue,
        };
        if frozen_names.contains(an) {
            remove_attr_with_space(attr, edits);
        }
    }
}

/// Inject `import <local> from "<spec>";` lines into the owner's instance script
/// (or a fresh `<script>` when it has none).  Mirrors `injectImports`.
fn inject_imports(model: &Model, imports: &[(String, String)], edits: &mut MagicEdit) {
    let lines = imports
        .iter()
        .map(|(local, spec)| {
            let quoted = serde_json::to_string(spec).unwrap_or_else(|_| format!("\"{}\"", spec));
            format!("  import {} from {};", local, quoted)
        })
        .collect::<Vec<_>>()
        .join("\n");

    let instance = model.ast.get("instance").filter(|v| !v.is_null());
    let body = instance
        .and_then(|i| i.get("content"))
        .and_then(|c| c.get("body"))
        .and_then(Value::as_array);
    if let Some(b) = body {
        if let Some(last) = b.last() {
            edits.append_left(off(last, "end") as usize, &format!("\n{}", lines));
            return;
        }
    }
    if let Some(content) = instance.and_then(|i| i.get("content")).filter(|v| !v.is_null()) {
        edits.append_left(off(content, "start") as usize, &format!("\n{}\n", lines));
        return;
    }
    edits.prepend(&format!("<script>\n{}\n</script>\n", lines));
}

/// Whole-program shake WITH L2 monomorphization.  `input` is the same shape as
/// `shake_program`; `options_json` is `{enabled, maxVariants, minSavings}`;
/// `own_size(source) -> number | null` is the per-module compiled-byte proxy the
/// net-win gate uses (the JS side runs svelte/compiler, so decisions match the TS
/// engine).  Returns `{ files: {id: code}, variants: {specifier: code} }`.
#[wasm_bindgen]
pub fn shake_program_with_mono(input_json: &str, options_json: &str, own_size: &js_sys::Function) -> String {
    let input: Value = match serde_json::from_str(input_json) {
        Ok(v) => v,
        Err(e) => return json!({ "error": e.to_string() }).to_string(),
    };
    let options: Value = serde_json::from_str(options_json).unwrap_or(Value::Null);
    let opts = MonoOptions {
        enabled: options.get("enabled").and_then(Value::as_bool).unwrap_or(false),
        max_variants: options.get("maxVariants").and_then(Value::as_u64).unwrap_or(8) as usize,
        min_savings: options.get("minSavings").and_then(Value::as_f64).unwrap_or(0.0),
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
    let entries: Vec<String> = input
        .get("entries")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();

    let mut escaped = HashSet::new();
    for m in &models {
        escaped.extend(m.escaped.iter().cloned());
    }
    for m in &mut models {
        if escaped.contains(&m.id) && !m.bail_reasons.iter().any(|r| r == ESCAPE_REASON) {
            m.bail_reasons.push(ESCAPE_REASON.to_string());
        }
    }

    let plans = run_fixpoint(&models);

    // L2: compute variants + bindings.  `own_size` is memoized by source string
    // (matching the TS `sizeCache`) so each distinct residual compiles once.
    // Memoized by SOURCE (matching the TS `sizeCache`): each distinct residual
    // compiles once, under the `id` of its first caller (the compiler filename).
    let mut size_memo: HashMap<String, Option<f64>> = HashMap::new();
    let (variants, bindings) = {
        let mut own_size_fn = |id: &str, src: &str| -> Option<f64> {
            if let Some(v) = size_memo.get(src) {
                return *v;
            }
            let res = own_size
                .call2(&JsValue::NULL, &JsValue::from_str(id), &JsValue::from_str(src))
                .ok()
                .and_then(|v| v.as_f64());
            size_memo.insert(src.to_string(), res);
            res
        };
        monomorphize(&models, &plans, &code_by_id, &entries, &opts, &mut own_size_fn)
    };

    // Base phases (identical to shake_program): fold bodies + drop props, then
    // strip dropped-prop attributes at call sites.
    let mut edits_map: HashMap<String, MagicEdit> = HashMap::new();
    let mut dropped: HashMap<String, HashSet<String>> = HashMap::new();
    let mut edited_spans: HashMap<String, Vec<Span>> = HashMap::new();
    for model in &models {
        let plan = &plans[&model.id];
        let mut edits = MagicEdit::new(code_by_id.get(&model.id).map(String::as_str).unwrap_or(""));
        let mut dead: Vec<Span> = Vec::new();
        let d = if plan.bail {
            HashSet::new()
        } else {
            shake_body(model, &plan.const_env(), &plan.set_env(), &mut edits, &mut dead)
        };
        dropped.insert(model.id.clone(), d);
        edited_spans.insert(model.id.clone(), dead);
        edits_map.insert(model.id.clone(), edits);
    }
    for model in &models {
        if let Some(edits) = edits_map.get_mut(&model.id) {
            let empty = Vec::new();
            let spans = edited_spans.get(&model.id).unwrap_or(&empty);
            remove_call_site_attributes(model, &dropped, edits, spans);
        }
    }

    // Phase 3 (L2): rewrite each bound `<Child …>` to its variant.
    let models_by_id: HashMap<&str, &Model> = models.iter().map(|m| (m.id.as_str(), m)).collect();
    rewrite_bound_call_sites(&models_by_id, &bindings, &code_by_id, &mut edits_map);

    let files: serde_json::Map<String, Value> = models
        .iter()
        .map(|m| (m.id.clone(), Value::String(edits_map.get(&m.id).map(|e| e.render()).unwrap_or_default())))
        .collect();
    let variants_obj: serde_json::Map<String, Value> =
        variants.into_iter().map(|(spec, code)| (spec, Value::String(code))).collect();
    json!({ "files": Value::Object(files), "variants": Value::Object(variants_obj) }).to_string()
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
    fn barrel_rendered_child_is_attributed_as_a_call() {
        let ast = json!({
            "type": "Root", "instance": Value::Null,
            "fragment": { "type": "Fragment", "nodes": [
                { "type": "Component", "name": "Lib", "start": 0, "end": 6, "attributes": [], "fragment": { "nodes": [] } }
            ] }
        });
        let edges = r#"[{"local":"Lib","to":"/Lib.svelte","kind":"barrel"}]"#;
        // A barrel-imported `<Lib/>` is attributed as a normal child call now (so
        // its value set is complete and it can fold), not bailed as unobservable.
        assert_eq!(
            analyze_edges(&ast, edges)["childCalls"],
            json!([{ "childId": "/Lib.svelte", "start": 0, "end": 6 }])
        );
    }

    #[test]
    fn namespace_member_render_is_attributed_as_a_call() {
        // `<ns.Lib/>` carries a dotted `name`; the Shell emits a `namespace` edge
        // whose `local` is that exact tag, so the engine attributes it by lookup.
        let ast = json!({
            "type": "Root", "instance": Value::Null,
            "fragment": { "type": "Fragment", "nodes": [
                { "type": "Component", "name": "ns.Lib", "start": 0, "end": 9, "attributes": [], "fragment": { "nodes": [] } }
            ] }
        });
        let edges = r#"[{"local":"ns.Lib","to":"/Lib.svelte","kind":"namespace"}]"#;
        assert_eq!(
            analyze_edges(&ast, edges)["childCalls"],
            json!([{ "childId": "/Lib.svelte", "start": 0, "end": 9 }])
        );
    }
}
