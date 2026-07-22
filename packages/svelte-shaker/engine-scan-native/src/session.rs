//! Chatty-protocol Round 2: `ShakeSession` — the native full-shake session.
//!
//! Two stages, so a Svelte AST never crosses the JS boundary:
//!  1. `parse` parses every file with rsvelte ONCE, keeps its AST (as the
//!     svelte/compiler-shaped JSON the engine reads), and returns the Round-1
//!     `parseFiles` facts so JS can resolve module edges.
//!  2. `shake({ edges, entries, escaped, mono, forceBail }, ownSize)` runs the
//!     whole-program shake + monomorphization over the retained ASTs through the
//!     environment-free engine-rs cores, and returns only the edits
//!     (`{ files: { id: code }, variants }`).
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

use napi::bindgen_prelude::Function;
use napi_derive::napi;
use rsvelte_core::ast::arena::with_serialize_arena;
use rsvelte_core::{parse, ParseOptions};
use serde_json::{json, Map, Value};
use svelte_shaker_engine::{shake_program_with_mono_value, MonoOptions};

use crate::parse_files::facts_from_root;
use crate::utf16::{convert_positions_to_utf16, Utf8ToUtf16};

/// How many times the inner cascade re-runs after force-bailing unparseable output
/// before falling back to a whole-program no-op. MUST equal the JS
/// `MAX_REVERT_ITERATIONS` (src/revert-cascade.ts) so the two converge identically.
const MAX_REVERT_ITERATIONS: usize = 3;

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

    /// Parse + retain every file, and return the Round-1 `parseFiles` facts (same
    /// shape as the stateless [`crate::parse_files`] export). `input_json` is
    /// `{ files: [{ id, code }] }`.
    #[napi]
    pub fn parse(&mut self, input_json: String) -> napi::Result<String> {
        let input: Value = serde_json::from_str(&input_json)
            .map_err(|e| napi::Error::from_reason(format!("session.parse: input: {e}")))?;
        let files = input.get("files").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);

        self.files.clear();
        self.files.reserve(files.len());
        let mut facts_out = Vec::with_capacity(files.len());
        for f in files {
            let id = f.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
            let code = f.get("code").and_then(Value::as_str).unwrap_or_default().to_string();
            // One parse feeds BOTH the retained shake AST and the Round-1 facts.
            match parse(&code, ParseOptions::default()) {
                Ok(root) => {
                    let (ast, facts) = with_serialize_arena(&root.arena, || {
                        (root_to_ast_value(&root, &code), facts_from_root(&id, &root))
                    });
                    facts_out.push(facts.into_json());
                    self.files.push(StoredFile { id, code, ast });
                }
                Err(_) => {
                    facts_out.push(json!({
                        "id": id, "imports": [], "renderedTags": [], "memberTags": [], "parseError": true
                    }));
                    // A file the engine cannot parse contributes nothing to the shake
                    // (its AST is Null → the engine skips it, sound under-shake).
                    self.files.push(StoredFile { id, code, ast: Value::Null });
                }
            }
        }

        serde_json::to_string(&json!({ "files": facts_out }))
            .map_err(|e| napi::Error::from_reason(format!("session.parse: serialize: {e}")))
    }

    /// Whole-program shake + monomorphization over the retained ASTs. `config_json`
    /// is `{ edges, entries?, escaped?, mono?, forceBail? }`; `own_size(id, source)`
    /// is the JS compiled-byte callback the net-win gate uses (same semantics as the
    /// wasm `shake_program_with_mono` `ownSize`). Returns `{ files: { id: code },
    /// variants: { specifier: code } }`.
    #[napi]
    pub fn shake(
        &self,
        config_json: String,
        own_size: Function<String, f64>,
    ) -> napi::Result<String> {
        let config: Value = serde_json::from_str(&config_json)
            .map_err(|e| napi::Error::from_reason(format!("session.shake: config: {e}")))?;
        let opts = MonoOptions::from_value(config.get("mono").unwrap_or(&Value::Null));

        // Build the engine program input ONCE (the ASTs are cloned a single time);
        // only `forceBail` changes between cascade passes.
        let files_arr: Vec<Value> = self
            .files
            .iter()
            .map(|f| json!({ "id": f.id, "ast": f.ast, "code": f.code }))
            .collect();
        let take_array = |key: &str| config.get(key).cloned().unwrap_or_else(|| Value::Array(vec![]));
        let mut input_map = Map::new();
        input_map.insert("files".into(), Value::Array(files_arr));
        input_map.insert("edges".into(), take_array("edges"));
        input_map.insert("entries".into(), take_array("entries"));
        input_map.insert("escaped".into(), take_array("escaped"));
        let mut input = Value::Object(input_map);

        // Seed force-bail with any ids the JS outer validation already rejected.
        let mut force_bail: Vec<String> = config
            .get("forceBail")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default();

        // The size callback runs synchronously on the JS thread (the shake — unlike
        // the parse — does no rayon fan-out, so the callback is never off-thread). A
        // JS throw or a null return both map to `None`, matching the wasm `ownSize`.
        // (id, source) is passed as ONE JSON `[id, source]` payload the JS wrapper
        // splits: napi 3.11's multi-arg `Function::call` mis-marshals a 2-tuple (once
        // the JS callback reads the args, the return read is corrupted and yields
        // `None` for a valid number), whereas a single arg is reliable. A returned
        // number => `Some`; a `null` (compile failed) or a JS throw fails the f64
        // conversion => `None`, exactly the wasm `ownSize` contract.
        let mut own_size_cb = |id: &str, src: &str| -> Option<f64> {
            let payload = serde_json::to_string(&(id, src)).ok()?;
            own_size.call(payload).ok()
        };

        // One shake pass at the given force-bail set. `input` (holding the retained
        // ASTs) is mutated in place — only `forceBail` changes between passes — and
        // handed to the core by reference, so the ASTs are never re-cloned.
        let emit = |input: &mut Value,
                    force_bail: &[String],
                    cb: &mut dyn FnMut(&str, &str) -> Option<f64>|
         -> Value {
            input["forceBail"] =
                Value::Array(force_bail.iter().map(|s| Value::String(s.clone())).collect());
            shake_program_with_mono_value(input, &opts, cb)
        };

        let mut last = emit(&mut input, &force_bail, &mut own_size_cb);
        for _ in 0..MAX_REVERT_ITERATIONS {
            let failed = self.unparseable(&last);
            if failed.is_empty() {
                return self.finish(last);
            }
            force_bail.extend(failed);
            last = emit(&mut input, &force_bail, &mut own_size_cb);
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
