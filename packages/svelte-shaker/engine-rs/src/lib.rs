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

mod analyze;
mod ast;
mod css;
mod dead_code;
mod eval;
mod mono;
mod plan;
mod props;
mod reverse;
mod shake;
mod transform;
mod unread;

use crate::analyze::*;
use crate::ast::*;
use crate::mono::*;
use crate::plan::*;
use crate::reverse::*;
use crate::shake::*;
use crate::transform::MagicEdit;
use crate::unread::collect_unread;

// Preserve the crate-root path the native (napi) scanner links against
// (`svelte_shaker_engine::find_never_passed_props`).
pub use crate::plan::find_never_passed_props;

// The native (napi) engine drives the same whole-program shake through these
// environment-free cores (`shake_program_value` / `shake_program_with_mono_value`
// are `pub fn` above); it builds the mono options with this re-exported type.
pub use crate::mono::MonoOptions;

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
    let (shadowed, debug, written) = template_bindings(&ast);
    json!({
        "props": props,
        "hasRestProp": has_rest,
        "shadowed": sorted(shadowed),
        "debug": sorted(debug),
        "written": sorted(written),
        "bail": component_bail(&ast),
        "childCalls": child_calls(&ast, &imports),
        "escaped": escaped_components(&ast, &imports, &imported_locals(&ast), &namespace_locals(&ast)),
    })
    .to_string()
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
    // Consumers outside the `.svelte` graph escape too (analyze.ts §4.2).
    stamp_module_escapes(&mut models, &input);

    let plans = run_fixpoint(&models);
    let out: serde_json::Map<String, Value> =
        plans.iter().map(|(id, plan)| (id.clone(), plan_to_json(plan))).collect();
    Value::Object(out).to_string()
}

/// JSON-string wrapper of {@link find_never_passed_props} for the WASM boundary.
#[wasm_bindgen]
pub fn find_never_passed_props_json(input_json: &str) -> String {
    let input: Value = match serde_json::from_str(input_json) {
        Ok(v) => v,
        Err(e) => return json!({ "error": e.to_string() }).to_string(),
    };
    find_never_passed_props(&input).to_string()
}

/// Whole-program shake: analyze + transform.  `input` is `{ files: [{id, ast,
/// code}], edges, entries }`.  Returns `{ id: slimmedSource }` for every file —
/// byte-for-byte the output of the always-on folds (the `svelteShaker` equivalent).
#[wasm_bindgen]
pub fn shake_program(input_json: &str) -> String {
    match serde_json::from_str::<Value>(input_json) {
        Ok(input) => shake_program_value(&input).to_string(),
        Err(e) => json!({ "error": e.to_string() }).to_string(),
    }
}

/// Environment-free core of [`shake_program`]: the program input is already parsed,
/// so there is no js_sys here and the native (napi) engine can call it directly
/// (docs/ARCHITECTURE.md §5 — the Engine stays environment-free). Returns the
/// `{ id: slimmedSource }` object.
pub fn shake_program_value(input: &Value) -> Value {
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

    // Revert cascade (index.ts `shakeWithRevertCascade`): the JS caller re-invokes
    // us with the ids of components whose emitted source failed to re-parse, so we
    // force-bail them here — they then fold nothing AND their owners keep every
    // call-site attribute, so a reverted child and its parent stay consistent.
    let force_bail: HashSet<String> = input
        .get("forceBail")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    for m in &mut models {
        if force_bail.contains(&m.id) && !m.bail_reasons.iter().any(|r| r == REVERT_REASON) {
            m.bail_reasons.push(REVERT_REASON.to_string());
        }
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
    // Consumers outside the `.svelte` graph escape too (analyze.ts §4.2).
    stamp_module_escapes(&mut models, input);

    let plans = run_fixpoint(&models);

    // Phase 0: reverse-removal ops per owner (docs §PR4) — the call-site inputs a
    // child can never read.  Computed before phase 1 so its regions protect phase
    // 1 from editing inside a span the reverse phase then deletes whole.
    let models_by_id: HashMap<&str, &Model> = models.iter().map(|m| (m.id.as_str(), m)).collect();
    let mut reverse: HashMap<String, Vec<ReverseOp>> = HashMap::new();
    for model in &models {
        if plans[&model.id].bail {
            continue; // a bailed owner is left completely untouched
        }
        let ops = collect_reverse_removals(model, &models_by_id, &plans);
        if !ops.is_empty() {
            reverse.insert(model.id.clone(), ops);
        }
    }

    // Phase 0b: unread declared props (docs §PR7).  Merge its (a) removals into the
    // reverse map (they never target the same attribute — declared vs undeclared),
    // and thread its (b) declaration drops into phase 1's `shake_body`.
    let unread = collect_unread(&models, &models_by_id, &plans);
    for (id, ops) in unread.removals {
        reverse.entry(id).or_default().extend(ops);
    }
    let unread_drops = unread.drops;
    let empty_drops: HashSet<String> = HashSet::new();

    // Phase 1: fold each body and drop its folded (and unread) props.
    let mut edits_map: HashMap<String, MagicEdit> = HashMap::new();
    let mut dropped: HashMap<String, HashSet<String>> = HashMap::new();
    let mut edited_spans: HashMap<String, Vec<Span>> = HashMap::new();
    for model in &models {
        let plan = &plans[&model.id];
        let mut edits = MagicEdit::new(code_by_id.get(&model.id).map(String::as_str).unwrap_or(""));
        let mut dead: Vec<Span> = Vec::new();
        let seed = reverse.get(&model.id).map(|ops| protect_spans(ops)).unwrap_or_default();
        let extra = unread_drops.get(&model.id).unwrap_or(&empty_drops);
        let d = if plan.bail {
            HashSet::new()
        } else {
            shake_body(model, &plan.const_env(), &plan.set_env(), &mut edits, &mut dead, &seed, extra)
        };
        dropped.insert(model.id.clone(), d);
        edited_spans.insert(model.id.clone(), dead);
        edits_map.insert(model.id.clone(), edits);
    }
    // Phase 2: remove call-site attributes for props the child actually dropped,
    // skipping any call site phase 1 folded away (its attributes went with it).
    for model in &models {
        // A forwarded expression (`<Child prop={ownerProp}/>`) was substituted to a
        // literal in phase 1 when `ownerProp` folds; give phase 2 the owner's env so
        // it recognizes that attribute as removable (interprocedural pass-through).
        let plan = &plans[&model.id];
        // Include the owner's `script_const_env` (docs §13.1): a forwarded owner
        // script constant is side-effect-free, so once the child drops the prop its
        // attribute is removable. Mirrors runBasePhases's `mergeLocalConstEnv`.
        let folded =
            if plan.bail { HashMap::new() } else { remap_to_local_names(&plan.const_env(), model) };
        let owner_env = merge_script_consts(&model.script_const_env, folded);
        if let Some(edits) = edits_map.get_mut(&model.id) {
            let empty = Vec::new();
            let spans = edited_spans.get(&model.id).unwrap_or(&empty);
            remove_call_site_attributes(model, &dropped, edits, spans, &owner_env);
        }
    }
    // Phase 2.5: reverse removals — delete the inputs the child can never read.
    for (id, ops) in &reverse {
        if let Some(edits) = edits_map.get_mut(id) {
            let empty = Vec::new();
            let spans = edited_spans.get(id).unwrap_or(&empty);
            apply_reverse_removals(ops, edits, spans);
        }
    }

    let out: serde_json::Map<String, Value> = models
        .iter()
        .map(|m| (m.id.clone(), Value::String(edits_map.get(&m.id).map(|e| e.render()).unwrap_or_default())))
        .collect();
    Value::Object(out)
}

/// Whole-program shake WITH monomorphization.  `input` is the same shape as
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
    let opts = MonoOptions::from_value(&options);
    // Adapt the JS `ownSize` function into the environment-free core's raw size
    // callback (the size memo lives in the core, matching the TS `sizeCache`).
    let mut js_size = |id: &str, src: &str| -> Option<f64> {
        own_size
            .call2(&JsValue::NULL, &JsValue::from_str(id), &JsValue::from_str(src))
            .ok()
            .and_then(|v| v.as_f64())
    };
    shake_program_with_mono_value(&input, &opts, &mut js_size).to_string()
}

/// Environment-free core of [`shake_program_with_mono`]: the program input is
/// already parsed and `own_size(id, source)` is a raw per-module size callback (the
/// wasm boundary adapts the JS function; the native engine passes a napi callback).
/// No js_sys here, so the Shell boundary holds. Returns `{ files, variants }`.
pub fn shake_program_with_mono_value(
    input: &Value,
    opts: &MonoOptions,
    own_size: &mut dyn FnMut(&str, &str) -> Option<f64>,
) -> Value {
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

    // Revert cascade (see `shake_program`): force-bail components the JS caller
    // flagged as unparseable so they are neither folded nor specialized.
    let force_bail: HashSet<String> = input
        .get("forceBail")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    for m in &mut models {
        if force_bail.contains(&m.id) && !m.bail_reasons.iter().any(|r| r == REVERT_REASON) {
            m.bail_reasons.push(REVERT_REASON.to_string());
        }
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
    // Consumers outside the `.svelte` graph escape too (analyze.ts §4.2).
    stamp_module_escapes(&mut models, input);

    let plans = run_fixpoint(&models);

    // Monomorphization: compute variants + bindings.  `own_size` is memoized by source string
    // (matching the TS `sizeCache`) so each distinct residual compiles once.
    // Memoized by SOURCE (matching the TS `sizeCache`): each distinct residual
    // compiles once, under the `id` of its first caller (the compiler filename).
    let mut size_memo: HashMap<String, Option<f64>> = HashMap::new();
    let (variants, bindings) = {
        let mut own_size_fn = |id: &str, src: &str| -> Option<f64> {
            if let Some(v) = size_memo.get(src) {
                return *v;
            }
            let res = own_size(id, src);
            size_memo.insert(src.to_string(), res);
            res
        };
        monomorphize(&models, &plans, &code_by_id, &entries, opts, &mut own_size_fn)
    };

    // Base phases (identical to shake_program): reverse-removal collection, fold
    // bodies + drop props, strip dropped-prop attributes, then the reverse removals.
    let models_by_id: HashMap<&str, &Model> = models.iter().map(|m| (m.id.as_str(), m)).collect();
    let mut reverse: HashMap<String, Vec<ReverseOp>> = HashMap::new();
    for model in &models {
        if plans[&model.id].bail {
            continue;
        }
        let ops = collect_reverse_removals(model, &models_by_id, &plans);
        if !ops.is_empty() {
            reverse.insert(model.id.clone(), ops);
        }
    }

    // Unread declared props (docs §PR7): same wiring as `shake_program`.
    let unread = collect_unread(&models, &models_by_id, &plans);
    for (id, ops) in unread.removals {
        reverse.entry(id).or_default().extend(ops);
    }
    let unread_drops = unread.drops;
    let empty_drops: HashSet<String> = HashSet::new();

    let mut edits_map: HashMap<String, MagicEdit> = HashMap::new();
    let mut dropped: HashMap<String, HashSet<String>> = HashMap::new();
    let mut edited_spans: HashMap<String, Vec<Span>> = HashMap::new();
    for model in &models {
        let plan = &plans[&model.id];
        let mut edits = MagicEdit::new(code_by_id.get(&model.id).map(String::as_str).unwrap_or(""));
        let mut dead: Vec<Span> = Vec::new();
        let seed = reverse.get(&model.id).map(|ops| protect_spans(ops)).unwrap_or_default();
        let extra = unread_drops.get(&model.id).unwrap_or(&empty_drops);
        let d = if plan.bail {
            HashSet::new()
        } else {
            shake_body(model, &plan.const_env(), &plan.set_env(), &mut edits, &mut dead, &seed, extra)
        };
        dropped.insert(model.id.clone(), d);
        edited_spans.insert(model.id.clone(), dead);
        edits_map.insert(model.id.clone(), edits);
    }
    for model in &models {
        let plan = &plans[&model.id];
        // Include the owner's `script_const_env` (docs §13.1): a forwarded owner
        // script constant is side-effect-free, so once the child drops the prop its
        // attribute is removable. Mirrors runBasePhases's `mergeLocalConstEnv`.
        let folded =
            if plan.bail { HashMap::new() } else { remap_to_local_names(&plan.const_env(), model) };
        let owner_env = merge_script_consts(&model.script_const_env, folded);
        if let Some(edits) = edits_map.get_mut(&model.id) {
            let empty = Vec::new();
            let spans = edited_spans.get(&model.id).unwrap_or(&empty);
            remove_call_site_attributes(model, &dropped, edits, spans, &owner_env);
        }
    }
    for (id, ops) in &reverse {
        if let Some(edits) = edits_map.get_mut(id) {
            let empty = Vec::new();
            let spans = edited_spans.get(id).unwrap_or(&empty);
            apply_reverse_removals(ops, edits, spans);
        }
    }

    // Phase 3 (monomorphization): rewrite each bound `<Child …>` to its variant.
    rewrite_bound_call_sites(&models_by_id, &bindings, &code_by_id, &mut edits_map);

    let files: serde_json::Map<String, Value> = models
        .iter()
        .map(|m| (m.id.clone(), Value::String(edits_map.get(&m.id).map(|e| e.render()).unwrap_or_default())))
        .collect();
    let variants_obj: serde_json::Map<String, Value> =
        variants.into_iter().map(|(spec, code)| (spec, Value::String(code))).collect();
    json!({ "files": Value::Object(files), "variants": Value::Object(variants_obj) })
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
    fn collects_written_names() {
        // A prop reassigned (`label = …`) or `++`ed in the instance script, and one
        // two-way `bind:`ed in the template, are all writes that block folding.
        let ast = json!({
            "type": "Root",
            "instance": { "content": { "body": [
                { "type": "ExpressionStatement", "expression": {
                    "type": "AssignmentExpression", "operator": "=",
                    "left": { "type": "Identifier", "name": "label" },
                    "right": { "type": "Literal", "value": "b" } } },
                { "type": "ExpressionStatement", "expression": {
                    "type": "UpdateExpression", "operator": "++",
                    "argument": { "type": "Identifier", "name": "count" } } }
            ] } },
            "fragment": { "type": "Fragment", "nodes": [
                { "type": "RegularElement", "name": "input", "attributes": [
                    { "type": "BindDirective", "name": "value",
                      "expression": { "type": "Identifier", "name": "bound" } } ] }
            ] }
        });
        assert_eq!(analyze(&ast)["written"], json!(["bound", "count", "label"]));
    }

    #[test]
    fn member_writes_are_not_collected() {
        // `o.x = …` and `o.x++` mutate an object, not a scalar prop — never blocked.
        let ast = json!({
            "type": "Root",
            "instance": { "content": { "body": [
                { "type": "ExpressionStatement", "expression": {
                    "type": "AssignmentExpression", "operator": "=",
                    "left": { "type": "MemberExpression", "object": { "type": "Identifier", "name": "o" },
                              "property": { "type": "Identifier", "name": "x" }, "computed": false },
                    "right": { "type": "Literal", "value": 1 } } }
            ] } },
            "fragment": { "type": "Fragment", "nodes": [] }
        });
        assert_eq!(analyze(&ast)["written"], json!([]));
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
