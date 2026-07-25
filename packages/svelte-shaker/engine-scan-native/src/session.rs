//! Chatty-protocol Round 2: `ShakeSession` — the native full-shake session.
//!
//! Two stages, so a Svelte AST never crosses the JS boundary:
//!  1. `parse` parses every file with rsvelte ONCE, keeps its AST (as the
//!     svelte/compiler-shaped JSON the engine reads), and returns the Round-1
//!     `parseFiles` facts so JS can resolve module edges.
//!  2. `shake({ edges, entries, escaped, mono, forceBail })` runs the whole-program
//!     shake + monomorphization over the retained ASTs through the environment-free
//!     engine-rs cores, and returns only the edits (`{ files: { id: code },
//!     variants }`). The monomorphization net-win gate's compiled-byte size proxy is
//!     computed in-process by rsvelte ({@link own_size}) — NO JS compiler callback.
//!
//! Soundness is layered exactly like the wasm driver (`src/wasm-engine.ts` +
//! `src/revert-cascade.ts`):
//!  - INNER cascade (here): after each shake, re-parse every emitted file with
//!    rsvelte; any file whose changed output no longer parses is force-bailed and
//!    the whole shake re-run, up to `MAX_REVERT_ITERATIONS`, else a whole-program
//!    no-op. Fast, because the re-parse stays in Rust.
//!  - OUTER validation (JS driver): a final svelte/compiler check on the changed
//!    files is the AUTHORITY; a residual failure is fed back as `forceBail`. Kept
//!    in JS on purpose — svelte/compiler, not rsvelte, decides what is valid.

use std::collections::HashSet;

use napi_derive::napi;
use rsvelte_core::ast::arena::with_serialize_arena;
use rsvelte_core::compiler::{compile, CompileOptions, CssMode, GenerateMode};
use rsvelte_core::{parse, ParseOptions};
use serde_json::{json, Map, Value};
use svelte_shaker_engine::{shake_program_with_mono_value, MonoOptions, ShakeFile};

use crate::parse_files::facts_from_root;
use crate::utf16::{convert_positions_to_utf16, Utf8ToUtf16};

/// How many times the inner cascade re-runs after force-bailing unparseable output
/// before falling back to a whole-program no-op. MUST equal the JS
/// `MAX_REVERT_ITERATIONS` (src/revert-cascade.ts) so the two converge identically.
const MAX_REVERT_ITERATIONS: usize = 3;

/// The monomorphization net-win gate's per-module compiled-byte size proxy, computed
/// FULLY IN RUST with rsvelte — the same client codegen `@rsvelte/compiler`'s
/// `compile_client` exposes, so the native engine never calls back into a JS compiler
/// for it (the whole point of the native path). `None` on a compile error (an
/// un-sizable module makes the gate decline the child, never bloat).
///
/// The gate must decide IDENTICALLY across the TS / WASM / native engines (parity is
/// test-gated), so this MUST match what the JS side measures: the JS engines call
/// `@rsvelte/compiler` `compile_client(source, id).js.length`, a UTF-16 code-unit
/// count over the SAME rsvelte rev this crate is pinned to. We mirror `compile_client`
/// exactly (only `generate` / `name` / `css` overridden) and count UTF-16 units so the
/// byte proxy is identical to the JS `.length`.
fn own_size(id: &str, source: &str) -> Option<f64> {
    let options = CompileOptions {
        generate: GenerateMode::Client,
        name: Some(id.to_string()),
        css: CssMode::External,
        ..Default::default()
    };
    // `compile` runs the full analyze+transform+codegen pipeline; a panic anywhere in
    // it (a compiler bug on some input shape) must NOT abort the Node process. Catch it
    // and treat the module as un-sizable — the gate then declines that child, never
    // bloat, exactly like a normal compile error. `AssertUnwindSafe`: on a caught unwind
    // the result is discarded and only the by-value source/options are read again, so no
    // torn state escapes.
    let compiled =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| compile(source, options)));
    match compiled {
        Ok(Ok(result)) => Some(result.js.code.encode_utf16().count() as f64),
        _ => None, // compile error OR panic -> un-sizable
    }
}

/// One retained file: its source plus the AST the engine shakes (svelte/compiler
/// JSON shape, UTF-16 offsets — exactly what the wasm path feeds).
struct StoredFile {
    id: String,
    code: String,
    ast: Value,
}

/// Serialize a parsed `Root` to the svelte/compiler-shaped JSON with UTF-16 offsets
/// — the same shape (and encoding) `parse_to_ast_value` produces, but reusing an
/// already-parsed `Root` so the Session parses each file only once. `Value::Null`
/// on a serialize failure (the engine then treats the file as unparseable).
fn root_to_ast_value(root: &rsvelte_core::ast::Root, code: &str) -> Value {
    let mut value = match serde_json::to_value(root) {
        Ok(value) => value,
        Err(_) => return Value::Null,
    };
    if !code.is_ascii() {
        let conv = Utf8ToUtf16::new(code);
        convert_positions_to_utf16(&mut value, &conv);
    }
    value
}

/// Whether `emitted` (one file's shaken output) still parses as valid Svelte via
/// rsvelte. Mirrors the JS `unparseableIds` per-file check.
fn reparses(code: &str) -> bool {
    parse(code, ParseOptions::default()).is_ok()
}

/// Parse + serialize a batch of `{ id, code }` inputs across cores, preserving input
/// order (`par_iter().collect()` keeps it — the shake iterates `self.files` in
/// program order). Returns each file's retained form plus its Round-1 facts JSON.
/// Thread-safe: each file's `Root` and its serialize arena stay on one worker thread,
/// and `SERIALIZE_ARENA` is a thread_local installed/restored per
/// `with_serialize_arena` call, so the fan-out shares no mutable state.
fn parse_batch(files: &[Value]) -> Vec<(StoredFile, Value)> {
    let build = |f: &Value| -> (StoredFile, Value) {
        let id = f.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
        let code = f.get("code").and_then(Value::as_str).unwrap_or_default().to_string();
        // One parse feeds BOTH the retained shake AST and the Round-1 facts.
        match parse(&code, ParseOptions::default()) {
            Ok(root) => {
                let (ast, facts) = with_serialize_arena(&root.arena, || {
                    (root_to_ast_value(&root, &code), facts_from_root(&id, &root))
                });
                (StoredFile { id, code, ast }, facts.into_json())
            }
            Err(_) => {
                // A file the engine cannot parse contributes nothing to the shake
                // (its AST is Null → the engine skips it, sound under-shake).
                let facts = json!({
                    "id": id.clone(), "imports": [], "renderedTags": [], "memberTags": [], "parseError": true
                });
                (StoredFile { id, code, ast: Value::Null }, facts)
            }
        }
    };
    use rayon::prelude::*;
    files.par_iter().map(build).collect()
}

#[napi]
pub struct ShakeSession {
    /// Retained files in input order (the engine iterates files in this order, and
    /// the mono variant ids key off the first caller — so order must match the JS
    /// program input for byte-identical output).
    files: Vec<StoredFile>,
}

impl Default for ShakeSession {
    fn default() -> Self {
        ShakeSession { files: Vec::new() }
    }
}

#[napi]
impl ShakeSession {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    /// Parse + retain every file (replacing any previously retained set), and return
    /// the Round-1 `parseFiles` facts (same shape as the stateless
    /// [`crate::parse_files`] export). `input_json` is `{ files: [{ id, code }] }`.
    // `catch_unwind`: a panic in rsvelte parse (or serialization) becomes a JS
    // exception instead of aborting the Node process — the JS driver then degrades to
    // the WASM/JS engine rather than crashing the build.
    #[napi(catch_unwind)]
    pub fn parse(&mut self, input_json: String) -> napi::Result<String> {
        let input: Value = serde_json::from_str(&input_json)
            .map_err(|e| napi::Error::from_reason(format!("session.parse: input: {e}")))?;
        let files = input.get("files").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);

        let results = parse_batch(files);
        self.files.clear();
        self.files.reserve(results.len());
        let mut facts_out = Vec::with_capacity(results.len());
        for (stored, facts) in results {
            self.files.push(stored);
            facts_out.push(facts);
        }

        serde_json::to_string(&json!({ "files": facts_out }))
            .map_err(|e| napi::Error::from_reason(format!("session.parse: serialize: {e}")))
    }

    /// Additive parse for the incremental crawl (chatty Round 1): parse + retain only
    /// the files whose id is not already retained (dedup guards a caller re-sending a
    /// file seen in an earlier round), append them in input order, and return facts
    /// for the NEWLY parsed files only — the caller already holds facts for anything
    /// it sent before. `input_json` is `{ files: [{ id, code }] }`.
    #[napi(catch_unwind)]
    pub fn parse_more(&mut self, input_json: String) -> napi::Result<String> {
        let input: Value = serde_json::from_str(&input_json)
            .map_err(|e| napi::Error::from_reason(format!("session.parseMore: input: {e}")))?;
        let files = input.get("files").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);

        let existing: HashSet<&str> = self.files.iter().map(|f| f.id.as_str()).collect();
        let fresh: Vec<Value> = files
            .iter()
            .filter(|f| {
                f.get("id").and_then(Value::as_str).map(|id| !existing.contains(id)).unwrap_or(false)
            })
            .cloned()
            .collect();
        drop(existing);

        let results = parse_batch(&fresh);
        self.files.reserve(results.len());
        let mut facts_out = Vec::with_capacity(results.len());
        for (stored, facts) in results {
            self.files.push(stored);
            facts_out.push(facts);
        }

        serde_json::to_string(&json!({ "files": facts_out }))
            .map_err(|e| napi::Error::from_reason(format!("session.parseMore: serialize: {e}")))
    }

    /// Whole-program shake + monomorphization over the retained ASTs. `config_json`
    /// is `{ edges, entries?, escaped?, mono?, forceBail? }`. The net-win gate's
    /// compiled-byte size proxy is computed IN RUST ({@link own_size}, rsvelte's
    /// client codegen) — unlike the wasm engine, the native path makes NO callback
    /// into a JS compiler. Returns `{ files: { id: code }, variants: { specifier:
    /// code } }`.
    // `catch_unwind`: `own_size` already catches compile panics, but the shake core
    // touches much more; any panic here becomes a JS exception the driver degrades on,
    // never a Node abort.
    #[napi(catch_unwind)]
    pub fn shake(&self, config_json: String) -> napi::Result<String> {
        let mut config: Value = serde_json::from_str(&config_json)
            .map_err(|e| napi::Error::from_reason(format!("session.shake: config: {e}")))?;
        let opts = MonoOptions::from_value(config.get("mono").unwrap_or(&Value::Null));

        // Borrow the retained ASTs into the core's `files` slice — no full-program AST
        // clone at the boundary; the engine clones each AST once, into its Model. The
        // engine config (`edges`/`entries`/`escaped`/`forceBail`) carries no ASTs, so
        // rebuilding it per cascade pass is cheap.
        let files: Vec<ShakeFile> =
            self.files.iter().map(|f| ShakeFile { id: &f.id, ast: &f.ast, code: &f.code }).collect();
        // `config` is a short-lived local; move each array out (leaving `Null`)
        // instead of deep-cloning it. `forceBail`/`mono` are read separately below and
        // are untouched by these takes.
        let mut take_array =
            |key: &str| config.get_mut(key).map(Value::take).unwrap_or_else(|| Value::Array(vec![]));
        let mut cfg_map = Map::new();
        cfg_map.insert("edges".into(), take_array("edges"));
        cfg_map.insert("entries".into(), take_array("entries"));
        cfg_map.insert("escaped".into(), take_array("escaped"));
        let mut engine_config = Value::Object(cfg_map);

        // Seed force-bail with any ids the JS outer validation already rejected.
        let mut force_bail: Vec<String> = config
            .get("forceBail")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default();

        // The size proxy is computed in-process by rsvelte ({@link own_size}), so
        // unlike the wasm path there is no JS callback to marshal and no thread
        // constraint. The monomorphization gate (`net_win`) still calls it only from
        // the SEQUENTIAL stage, but that is now incidental rather than required.
        let mut own_size_cb = |id: &str, src: &str| -> Option<f64> { own_size(id, src) };

        // One shake pass at the given force-bail set. Only `forceBail` changes between
        // passes; the borrowed `files` and the rest of the config are reused as-is, so
        // the ASTs are never re-cloned at the boundary.
        let emit = |engine_config: &mut Value,
                    force_bail: &[String],
                    cb: &mut dyn FnMut(&str, &str) -> Option<f64>|
         -> Value {
            engine_config["forceBail"] =
                Value::Array(force_bail.iter().map(|s| Value::String(s.clone())).collect());
            shake_program_with_mono_value(&files, engine_config, &opts, cb)
        };

        let mut last = emit(&mut engine_config, &force_bail, &mut own_size_cb);
        for _ in 0..MAX_REVERT_ITERATIONS {
            let failed = self.unparseable(&last);
            if failed.is_empty() {
                return self.finish(last);
            }
            force_bail.extend(failed);
            last = emit(&mut engine_config, &force_bail, &mut own_size_cb);
        }
        if self.unparseable(&last).is_empty() {
            return self.finish(last);
        }

        // Never converged: whole-program no-op — every file reverts to its original
        // (always sound). Keep the last pass's `variants`; the untouched owner files
        // import none of them, so they are simply never requested.
        let mut files = Map::new();
        for f in &self.files {
            files.insert(f.id.clone(), Value::String(f.code.clone()));
        }
        let variants = last.get("variants").cloned().unwrap_or_else(|| json!({}));
        serde_json::to_string(&json!({ "files": Value::Object(files), "variants": variants }))
            .map_err(|e| napi::Error::from_reason(format!("session.shake: serialize: {e}")))
    }

    /// The retained ids whose emitted output changed AND no longer re-parses.
    fn unparseable(&self, result: &Value) -> Vec<String> {
        let files = match result.get("files").and_then(Value::as_object) {
            Some(f) => f,
            None => return Vec::new(),
        };
        let mut failed = Vec::new();
        for f in &self.files {
            match files.get(&f.id).and_then(Value::as_str) {
                Some(code) if code != f.code && !reparses(code) => failed.push(f.id.clone()),
                _ => {}
            }
        }
        failed
    }

    fn finish(&self, result: Value) -> napi::Result<String> {
        serde_json::to_string(&result)
            .map_err(|e| napi::Error::from_reason(format!("session.shake: serialize: {e}")))
    }
}
