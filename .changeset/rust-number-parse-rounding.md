---
'svelte-shaker': patch
---

Fix the Rust (WASM/native) engine folding a high-precision numeric prop literal to a value one ULP off what JavaScript computes, breaking byte-for-byte agreement with the TypeScript engine (and, in principle, the rendered output). When the app's AST crossed into the Rust engine as JSON, `serde_json`'s float parser rounded some decimal integer literals to the neighbouring `f64` — e.g. `123456789012345680000` decoded to `123456789012345670000` — so a folded prop like `<Sub n={123456789012345680000} />` produced a different number than the (correct) TypeScript engine. The engine now recovers each numeric literal from its verbatim source (`raw`) with Rust's correctly-rounded `str::parse::<f64>`, matching JavaScript's `Number` semantics; this only affects literals needing more than 17 significant digits, where the old parse diverged. Non-decimal (`0x`/`0o`/`0b`) and `BigInt` literals are unaffected.

The bundled WASM engine carries this fix immediately; the optional `svelte-shaker-engine-scan-native` binary picks it up on its next release.
