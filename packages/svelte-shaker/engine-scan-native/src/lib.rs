//! Native (napi) prop scanner for svelte-shaker.
//!
//! The fast path for the ESLint rule `svelte/no-useless-props`: instead of parsing
//! every component in JS and shipping a serialized AST across the JS boundary into
//! the WASM engine, this addon parses with rsvelte natively (in parallel) and
//! analyzes in-process.
//!
//! Two scan paths, both pinned to the JS engine and to each other:
//!  - [`scan`] — the typed path (goal B): walks rsvelte's typed `Root` directly and
//!    never builds the full-AST `serde_json::Value` (`typed_scan`). This is the
//!    default the ESLint rule calls.
//!  - [`scan_via_value`] — the oracle: serializes each AST to the rsvelte JSON shape
//!    and runs the already-validated `svelte_shaker_engine::find_never_passed_props`
//!    (itself pinned byte-for-byte to the TS engine). Kept as the differential
//!    reference for `scan` (see the corpus test), and as a drop-in fallback.
//!
//! Input/output stay as JSON strings: the JS `buildAnalyzeInputSync` crawl already
//! produces `{ files: [{id, code}], edges }` with resolution done, so the addon only
//! adds native parsing + analysis. Output is `{ fileId: [{name, start, end}] }` with
//! UTF-16 offsets — the same shape as the WASM `find_never_passed_props_json`.

use std::collections::HashMap;

use napi_derive::napi;
use rayon::prelude::*;
use rsvelte_core::ast::arena::with_serialize_arena;
use rsvelte_core::{parse, ParseOptions};
use serde_json::{json, Value};

mod typed_scan;
mod utf16;
use utf16::{convert_positions_to_utf16, Utf8ToUtf16};

/// Group the resolved edges into a per-file import map (tag name -> child id),
/// mirroring engine-rs `edge_imports` grouped by `from`.
fn imports_by_file(edges: &[Value]) -> HashMap<String, HashMap<String, String>> {
    let mut out: HashMap<String, HashMap<String, String>> = HashMap::new();
    for e in edges {
        if let (Some(from), Some(local), Some(to)) = (
            e.get("from").and_then(Value::as_str),
            e.get("local").and_then(Value::as_str),
            e.get("to").and_then(Value::as_str),
        ) {
            out.entry(from.to_string()).or_default().insert(local.to_string(), to.to_string());
        }
    }
    out
}

fn parse_input(input_json: &str) -> napi::Result<(Vec<Value>, Vec<Value>)> {
    let input: Value = serde_json::from_str(input_json)
        .map_err(|e| napi::Error::from_reason(format!("scan: parse input: {e}")))?;
    let files = input.get("files").and_then(Value::as_array).cloned().unwrap_or_default();
    let edges = input.get("edges").and_then(Value::as_array).cloned().unwrap_or_default();
    Ok((files, edges))
}

/// Scan a whole resolved program for never-passed props (typed path, goal B).
///
/// `input_json` is `{ "files": [{ "id", "code" }], "edges": [...] }` — the output of
/// the JS-side `buildAnalyzeInputSync` crawl. Files are parsed and modeled in
/// parallel (rayon) over rsvelte's typed AST, then the whole-program never-passed
/// analysis runs once.
#[napi]
pub fn scan(input_json: String) -> napi::Result<String> {
    let (files, edges) = parse_input(&input_json)?;
    let imports = imports_by_file(&edges);
    let empty: HashMap<String, String> = HashMap::new();

    // Source kept by id for the UTF-16 remap of reported spans on non-ASCII files.
    let codes: HashMap<String, String> = files
        .iter()
        .filter_map(|f| {
            let id = f.get("id").and_then(Value::as_str)?;
            let code = f.get("code").and_then(Value::as_str)?;
            Some((id.to_string(), code.to_string()))
        })
        .collect();

    let models: Vec<typed_scan::FileModel> = files
        .par_iter()
        .filter_map(|f| {
            let id = f.get("id").and_then(Value::as_str)?;
            let code = f.get("code").and_then(Value::as_str).unwrap_or_default();
            typed_scan::build_model(id, code, imports.get(id).unwrap_or(&empty))
        })
        .collect();

    let out = typed_scan::never_passed(models, &codes);
    serde_json::to_string(&out)
        .map_err(|e| napi::Error::from_reason(format!("scan: serialize output: {e}")))
}

/// Parse one component's source into the rsvelte JSON AST with UTF-16 offsets — the
/// exact shape (and encoding) `svelte/compiler`'s modern parse produces, so the
/// Value engine reads it unchanged. `Value::Null` on a parse error (the engine then
/// skips the file — sound under-reporting).
fn parse_to_ast_value(code: &str) -> Value {
    let root = match parse(code, ParseOptions::default()) {
        Ok(root) => root,
        Err(_) => return Value::Null,
    };
    let value = with_serialize_arena(&root.arena, || serde_json::to_value(&root));
    let mut value = match value {
        Ok(value) => value,
        Err(_) => return Value::Null,
    };
    if !code.is_ascii() {
        let conv = Utf8ToUtf16::new(code);
        convert_positions_to_utf16(&mut value, &conv);
    }
    value
}

/// The Value-engine oracle (and fallback): serialize every AST to the rsvelte JSON
/// shape and run the validated `find_never_passed_props`. Output is identical to
/// [`scan`]; the corpus test asserts byte-for-byte agreement between the two.
#[napi]
pub fn scan_via_value(input_json: String) -> napi::Result<String> {
    let (files, edges) = parse_input(&input_json)?;
    let parsed: Vec<Value> = files
        .par_iter()
        .map(|f| {
            let id = f.get("id").and_then(Value::as_str).unwrap_or_default();
            let code = f.get("code").and_then(Value::as_str).unwrap_or_default();
            json!({ "id": id, "ast": parse_to_ast_value(code) })
        })
        .collect();

    let engine_input = json!({ "files": parsed, "edges": Value::Array(edges) });
    let out = svelte_shaker_engine::find_never_passed_props(&engine_input);
    serde_json::to_string(&out)
        .map_err(|e| napi::Error::from_reason(format!("scan_via_value: serialize output: {e}")))
}

/// Profiling helper: `{ typedMs, valueMs, files }` — the typed path vs the Value
/// oracle on the same input. Used by the corpus benchmark only.
#[napi]
pub fn scan_profile(input_json: String) -> napi::Result<String> {
    use std::time::Instant;
    let (files, edges) = parse_input(&input_json)?;
    let imports = imports_by_file(&edges);
    let empty: HashMap<String, String> = HashMap::new();
    let codes: HashMap<String, String> = files
        .iter()
        .filter_map(|f| {
            Some((
                f.get("id").and_then(Value::as_str)?.to_string(),
                f.get("code").and_then(Value::as_str)?.to_string(),
            ))
        })
        .collect();

    let t0 = Instant::now();
    let models: Vec<typed_scan::FileModel> = files
        .par_iter()
        .filter_map(|f| {
            let id = f.get("id").and_then(Value::as_str)?;
            let code = f.get("code").and_then(Value::as_str).unwrap_or_default();
            typed_scan::build_model(id, code, imports.get(id).unwrap_or(&empty))
        })
        .collect();
    let _ = typed_scan::never_passed(models, &codes);
    let typed_ms = t0.elapsed().as_secs_f64() * 1000.0;

    let t1 = Instant::now();
    let parsed: Vec<Value> = files
        .par_iter()
        .map(|f| {
            let id = f.get("id").and_then(Value::as_str).unwrap_or_default();
            let code = f.get("code").and_then(Value::as_str).unwrap_or_default();
            json!({ "id": id, "ast": parse_to_ast_value(code) })
        })
        .collect();
    let engine_input = json!({ "files": parsed, "edges": Value::Array(edges) });
    let _ = svelte_shaker_engine::find_never_passed_props(&engine_input);
    let value_ms = t1.elapsed().as_secs_f64() * 1000.0;

    Ok(format!(
        "{{\"typedMs\":{typed_ms},\"valueMs\":{value_ms},\"files\":{}}}",
        files.len()
    ))
}
