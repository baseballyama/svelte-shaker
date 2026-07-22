//! Chatty-protocol M0 spike (docs/CHATTY-PROTOCOL.md) — TEMPORARY, replaced by
//! the real Session API in M1.
//!
//! Proves rsvelte can parse a whole program IN-PROCESS inside the engine (on both
//! the wasm and native targets) and lets us measure that parse cost on a real app
//! WITHOUT ever crossing the JSON-AST boundary. The only thing returned per file
//! is its import specifiers — the small payload the future `parseFiles` step hands
//! back to JS for module resolution — so the timing reflects "parse + extract
//! edges", the actual chatty-protocol round, not a full-AST serialization.

use rsvelte_core::ast::arena::with_serialize_arena;
use rsvelte_core::ast::Root;
use rsvelte_core::{parse, ParseOptions};
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

/// One `import … from "source"` declaration, reduced to the source module and the
/// local names it binds — everything the JS resolve step needs, and nothing else.
pub struct ImportSpec {
    pub source: String,
    pub names: Vec<String>,
}

/// Parse one component's source with rsvelte and return the instance-script import
/// specifiers. `None` on a parse error (the caller skips the file). Target-agnostic
/// so the wasm bench export and the napi prototype share one implementation.
pub fn file_import_specifiers(code: &str) -> Option<Vec<ImportSpec>> {
    let root: Root = parse(code, ParseOptions::default()).ok()?;
    // `as_json()` resolves JsNodeIds through the arena, so it must be installed.
    Some(with_serialize_arena(&root.arena, || {
        let program = match root.instance.as_ref() {
            Some(script) => script.content.as_json(),
            None => return Vec::new(),
        };
        let body = match program.get("body").and_then(Value::as_array) {
            Some(body) => body,
            None => return Vec::new(),
        };
        let mut out = Vec::new();
        for stmt in body {
            if stmt.get("type").and_then(Value::as_str) != Some("ImportDeclaration") {
                continue;
            }
            let source = stmt
                .get("source")
                .and_then(|s| s.get("value"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let names = stmt
                .get("specifiers")
                .and_then(Value::as_array)
                .map(|specs| {
                    specs
                        .iter()
                        .filter_map(|sp| {
                            sp.get("local")
                                .and_then(|l| l.get("name"))
                                .and_then(Value::as_str)
                                .map(str::to_string)
                        })
                        .collect()
                })
                .unwrap_or_default();
            out.push(ImportSpec { source, names });
        }
        out
    }))
}

fn specs_to_json(specs: &[ImportSpec]) -> Value {
    Value::Array(
        specs
            .iter()
            .map(|s| json!({ "source": s.source, "names": s.names }))
            .collect(),
    )
}

/// Bench export: `{ files: [{ id, code }] }` in, `{ files: [{ id, imports }],
/// parseErrors, importEdges }` out. Single-threaded on purpose — wasm has no
/// thread pool, so this is the honest wasm-target parse cost.
#[wasm_bindgen]
pub fn parse_files_bench(input_json: &str) -> String {
    let input: Value = match serde_json::from_str(input_json) {
        Ok(v) => v,
        Err(e) => return json!({ "error": e.to_string() }).to_string(),
    };
    let files = input.get("files").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);

    let mut out_files = Vec::with_capacity(files.len());
    let mut parse_errors: u32 = 0;
    let mut import_edges: u32 = 0;
    for f in files {
        let id = f.get("id").and_then(Value::as_str).unwrap_or_default();
        let code = f.get("code").and_then(Value::as_str).unwrap_or_default();
        match file_import_specifiers(code) {
            Some(specs) => {
                import_edges += specs.len() as u32;
                out_files.push(json!({ "id": id, "imports": specs_to_json(&specs) }));
            }
            None => {
                parse_errors += 1;
                out_files.push(json!({ "id": id, "imports": [] }));
            }
        }
    }

    json!({ "files": out_files, "parseErrors": parse_errors, "importEdges": import_edges })
        .to_string()
}
