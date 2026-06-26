---
'svelte-shaker': minor
---

Add a Rust/WASM `find_never_passed_props` (engine) and its `find_never_passed_props_json`
WASM export — the native counterpart of the TS `findNeverPassedProps`, pinned
byte-for-byte to it by a differential test. This is the foundation for a fully
native (napi) prop scan: the analysis now runs in Rust, so a native caller can
parse with the rsvelte parser and analyze without crossing an AST/JSON boundary.
