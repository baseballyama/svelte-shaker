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

mod parse_files;
mod session;
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

    let refs: Vec<&typed_scan::FileModel> = models.iter().collect();
    let out = typed_scan::never_passed(&refs, &codes);
    serde_json::to_string(&out)
        .map_err(|e| napi::Error::from_reason(format!("scan: serialize output: {e}")))
}

/// Chatty-protocol Round 1: parse every file with rsvelte (in parallel) and return
/// the small per-file facts the JS crawl needs to resolve module edges — nothing
/// crosses the boundary but import specifiers and rendered component tag names.
///
/// `input_json` is `{ "files": [{ "id", "code" }] }`. Output is `{ "files": [{ id,
/// imports: [{ local, imported, source }], renderedTags: [string], memberTags:
/// [string], parseError: bool }] }`, one entry per input file in input order. The
/// extraction mirrors the JS `importSources` / `renderedComponentTagNames` /
/// `memberComponentTags` byte-for-byte (pinned by `tests/native-parse-files.test.ts`).
#[napi]
pub fn parse_files(input_json: String) -> napi::Result<String> {
    let (files, _edges) = parse_input(&input_json)?;

    let rows: Vec<Value> = files
        .par_iter()
        .map(|f| {
            let id = f.get("id").and_then(Value::as_str).unwrap_or_default();
            let code = f.get("code").and_then(Value::as_str).unwrap_or_default();
            parse_files::parse_one(id, code).into_json()
        })
        .collect();

    serde_json::to_string(&json!({ "files": rows }))
        .map_err(|e| napi::Error::from_reason(format!("parse_files: serialize: {e}")))
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
    let refs: Vec<&typed_scan::FileModel> = models.iter().collect();
    let _ = typed_scan::never_passed(&refs, &codes);
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

// ===========================================================================
// Resident daemon (goal step 9): keep per-file models in memory so an editor /
// LSP can full-scan once at startup and then re-scan incrementally on each edit.
//
// The expensive part of a scan is PARSING (~53 ms of the ~57 ms full scan); the
// whole-program assembly (escape union + usage aggregation + report) is only a
// few ms. So the daemon caches each file's lightweight `FileModel` (props,
// escapes, call sites — no AST), and `update` re-parses ONLY the changed files
// before re-running the cheap assembly over the whole cached set. A single-file
// edit therefore re-scans in ~1 ms instead of ~57 ms, while staying byte-for-byte
// identical to a cold `scan` (the daemon test asserts this).
//
// A file's edges (`from == id`) derive only from its own imports, so a file's
// model never goes stale unless that file itself changes — re-parsing just the
// changed files is sound. Callers pass the full current edge set each `update`.
// ===========================================================================

/// In-memory scan state for incremental re-scans. Construct once (`new`), seed
/// with `init`, then call `update` per change set.
#[napi]
pub struct ScanDaemon {
    models: HashMap<String, typed_scan::FileModel>,
    /// Source kept by id for the UTF-16 remap of reported spans on non-ASCII files.
    codes: HashMap<String, String>,
}

impl Default for ScanDaemon {
    fn default() -> Self {
        ScanDaemon { models: HashMap::new(), codes: HashMap::new() }
    }
}

#[napi]
impl ScanDaemon {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    /// Full scan: parse every file, cache its model, and return the report.
    /// `input_json` is the same `{ files: [{id, code}], edges }` as [`scan`].
    #[napi]
    pub fn init(&mut self, input_json: String) -> napi::Result<String> {
        let (files, edges) = parse_input(&input_json)?;
        self.models.clear();
        self.codes.clear();
        self.rebuild(&files, &edges);
        self.report()
    }

    /// Incremental re-scan. `input_json` is `{ files: [{id, code}], edges, removed?: [id] }`
    /// where `files` are the changed/added files, `edges` is the full current edge
    /// set, and `removed` lists deleted files. Re-parses only `files`, drops
    /// `removed`, then re-runs the whole-program assembly over the cached models.
    #[napi]
    pub fn update(&mut self, input_json: String) -> napi::Result<String> {
        let input: Value = serde_json::from_str(&input_json)
            .map_err(|e| napi::Error::from_reason(format!("update: parse input: {e}")))?;
        if let Some(removed) = input.get("removed").and_then(Value::as_array) {
            for id in removed.iter().filter_map(Value::as_str) {
                self.models.remove(id);
                self.codes.remove(id);
            }
        }
        let empty: Vec<Value> = Vec::new();
        let files = input.get("files").and_then(Value::as_array).cloned().unwrap_or_default();
        let edges = input.get("edges").and_then(Value::as_array).unwrap_or(&empty);
        self.rebuild(&files, edges);
        self.report()
    }

    /// (Re)build models for `files` (parsed in parallel) and merge them into the
    /// cache. A file that fails to parse is dropped from the cache — same sound
    /// "skip on parse error" the cold scan uses.
    fn rebuild(&mut self, files: &[Value], edges: &[Value]) {
        let imports = imports_by_file(edges);
        let empty: HashMap<String, String> = HashMap::new();
        let built: Vec<(String, String, Option<typed_scan::FileModel>)> = files
            .par_iter()
            .map(|f| {
                let id = f.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
                let code = f.get("code").and_then(Value::as_str).unwrap_or_default().to_string();
                let model = typed_scan::build_model(&id, &code, imports.get(&id).unwrap_or(&empty));
                (id, code, model)
            })
            .collect();
        for (id, code, model) in built {
            match model {
                Some(m) => {
                    self.codes.insert(id.clone(), code);
                    self.models.insert(id, m);
                }
                None => {
                    self.models.remove(&id);
                    self.codes.remove(&id);
                }
            }
        }
    }

    fn report(&self) -> napi::Result<String> {
        let refs: Vec<&typed_scan::FileModel> = self.models.values().collect();
        let out = typed_scan::never_passed(&refs, &self.codes);
        serde_json::to_string(&out)
            .map_err(|e| napi::Error::from_reason(format!("daemon: serialize output: {e}")))
    }
}
