---
'svelte-shaker': patch
---

Faster builds via an in-process native (napi) Rust engine — the same output, produced more cheaply. When a prebuilt `svelte-shaker-engine-scan-native` binary is installed for the platform (an optional dependency), `engine: 'auto'` runs the whole shake in process — parsing with rsvelte and returning only edits, so no whole-program AST crosses the JS boundary — with no component-count size gate; on a large app the shake dropped from ~4.4s (JS engine) to ~3.5s with monomorphization on. Without a native binary it falls back to the WASM engine (small/medium apps) or the JS engine (large), unchanged. `engine: 'rust'` prefers native, then WASM. All three engines are byte-identical (differentially tested). The `parser` option now controls only the JS/WASM engines' parse; the native engine always parses in process with rsvelte, and `parser: 'svelte'` forces the native engine off.
