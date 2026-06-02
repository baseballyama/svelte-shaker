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
