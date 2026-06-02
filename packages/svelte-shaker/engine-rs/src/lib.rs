//! WASM core for svelte-shaker (docs/RUST-MIGRATION.md M4+).
//!
//! Self-contained on purpose: it analyzes a Svelte component AST handed in as
//! JSON (the modern parse shape — produced on the JS side by rsvelte or
//! svelte/compiler), so it has NO build dependency on the rsvelte compiler crate
//! and builds to a small, cross-platform `wasm` artifact. It is being ported one
//! validated slice at a time, each pinned against the TS engine by a differential
//! test (`packages/svelte-shaker/tests/wasm-m4.test.ts`).

use serde_json::{json, Value};
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

/// Analyze one component AST (JSON), returning the per-file model fields ported
/// so far: declared props, whether a `...rest` is present, the shadowed /
/// `{@debug}` names that block folding, and the whole-component bail reasons.
/// `{"error": "..."}` on malformed input.
#[wasm_bindgen]
pub fn analyze_component(ast_json: &str) -> String {
    let ast: Value = match serde_json::from_str(ast_json) {
        Ok(v) => v,
        Err(e) => return json!({ "error": e.to_string() }).to_string(),
    };
    let (props, has_rest) = declared_props(&ast);
    let (shadowed, debug) = template_bindings(&ast);
    json!({
        "props": props,
        "hasRestProp": has_rest,
        "shadowed": sorted(shadowed),
        "debug": sorted(debug),
        "bail": component_bail(&ast),
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn analyze(ast: &Value) -> Value {
        serde_json::from_str(&analyze_component(&ast.to_string())).unwrap()
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
}
