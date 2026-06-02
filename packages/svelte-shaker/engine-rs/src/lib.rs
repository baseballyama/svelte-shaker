//! WASM core for svelte-shaker (docs/RUST-MIGRATION.md M4+).
//!
//! Self-contained on purpose: it analyzes a Svelte component AST handed in as
//! JSON (the modern parse shape — produced on the JS side by rsvelte or
//! svelte/compiler), so it has NO build dependency on the rsvelte compiler crate
//! and builds to a small, cross-platform `wasm` artifact. This is the first
//! validated slice of porting the analysis to Rust: it mirrors a piece of
//! `analyze.ts` and the differential test pins it against the TS engine.

use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

/// `node[key] === val` for a string field, false if absent or non-string.
fn str_eq(node: &Value, key: &str, val: &str) -> bool {
    node.get(key).and_then(Value::as_str) == Some(val)
}

/// The declared prop names of a component, in source order — the `Property` keys
/// of the `let { ... } = $props()` `ObjectPattern` (a `...rest` is skipped, like
/// `analyze.ts`). Empty when the component has no `$props()` destructuring.
fn declared_props(ast: &Value) -> Vec<String> {
    let body = match ast
        .get("instance")
        .and_then(|i| i.get("content"))
        .and_then(|c| c.get("body"))
        .and_then(Value::as_array)
    {
        Some(b) => b,
        None => return Vec::new(),
    };

    for stmt in body {
        if !str_eq(stmt, "type", "VariableDeclaration") {
            continue;
        }
        let decls = match stmt.get("declarations").and_then(Value::as_array) {
            Some(d) => d,
            None => continue,
        };
        for decl in decls {
            let init = decl.get("init").unwrap_or(&Value::Null);
            let id = decl.get("id").unwrap_or(&Value::Null);
            let is_props_call = str_eq(init, "type", "CallExpression")
                && init
                    .get("callee")
                    .map(|c| str_eq(c, "type", "Identifier") && str_eq(c, "name", "$props"))
                    .unwrap_or(false);
            if !is_props_call || !str_eq(id, "type", "ObjectPattern") {
                continue;
            }
            let mut names = Vec::new();
            if let Some(props) = id.get("properties").and_then(Value::as_array) {
                for p in props {
                    // `...rest` (RestElement) holds only UNDECLARED props — skip it.
                    if !str_eq(p, "type", "Property") {
                        continue;
                    }
                    if let Some(name) = p
                        .get("key")
                        .filter(|k| str_eq(k, "type", "Identifier"))
                        .and_then(|k| k.get("name"))
                        .and_then(Value::as_str)
                    {
                        names.push(name.to_string());
                    }
                }
            }
            return names; // the first `$props()` destructuring wins
        }
    }
    Vec::new()
}

/// Whole-component bail reasons: `<svelte:options accessors|customElement>` makes
/// props externally settable, so the component is left untouched (analyze.ts §4.1).
fn component_bail(ast: &Value) -> Vec<String> {
    let mut reasons = Vec::new();
    collect_options_bail(ast, &mut reasons);
    reasons
}

fn collect_options_bail(node: &Value, out: &mut Vec<String>) {
    match node {
        Value::Object(map) => {
            if str_eq(node, "type", "SvelteOptions") {
                if let Some(attrs) = node.get("attributes").and_then(Value::as_array) {
                    for a in attrs {
                        if str_eq(a, "type", "Attribute") {
                            if let Some(name) = a.get("name").and_then(Value::as_str) {
                                if name == "accessors" || name == "customElement" {
                                    out.push(format!("<svelte:options {name}>"));
                                }
                            }
                        }
                    }
                }
            }
            for v in map.values() {
                collect_options_bail(v, out);
            }
        }
        Value::Array(items) => {
            for v in items {
                collect_options_bail(v, out);
            }
        }
        _ => {}
    }
}

/// Extract declared prop names + whole-component bail reasons from a component
/// AST (JSON). Returns `{"props": [...], "bail": [...]}` or `{"error": "..."}`.
#[wasm_bindgen]
pub fn analyze_props(ast_json: &str) -> String {
    let ast: Value = match serde_json::from_str(ast_json) {
        Ok(v) => v,
        Err(e) => return json!({ "error": e.to_string() }).to_string(),
    };
    json!({ "props": declared_props(&ast), "bail": component_bail(&ast) }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_prop_names_skipping_rest() {
        // Minimal modern-AST shape: instance.content.body has the $props() decl.
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
        let out: Value = serde_json::from_str(&analyze_props(&ast.to_string())).unwrap();
        assert_eq!(out["props"], json!(["variant", "size"]));
        assert_eq!(out["bail"], json!([]));
    }

    #[test]
    fn flags_accessors_bail() {
        let ast = json!({
            "type": "Root",
            "instance": Value::Null,
            "fragment": { "type": "Fragment", "nodes": [
                { "type": "SvelteOptions", "attributes": [
                    { "type": "Attribute", "name": "accessors" }
                ] }
            ] }
        });
        let out: Value = serde_json::from_str(&analyze_props(&ast.to_string())).unwrap();
        assert_eq!(out["props"], json!([]));
        assert_eq!(out["bail"], json!(["<svelte:options accessors>"]));
    }
}
