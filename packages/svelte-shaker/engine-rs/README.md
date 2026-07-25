# svelte-shaker-engine

The Rust core of the svelte-shaker engine (`docs/RUST-MIGRATION.md` M4+): the
whole-program analysis, the monomorphization graph/gate, and the transform. It has
no boundary of its own — it is linked as an **rlib** by
[`engine-scan-native`](../engine-scan-native), the napi addon that owns the JS
boundary. Every slice is pinned against the TypeScript engine by a differential test
(`packages/svelte-shaker/tests/native-full-shake.test.ts`).

## Design

**Self-contained — no `rsvelte_core` build dependency.** The crate analyzes a
Svelte component AST handed in as a **`serde_json::Value`** (the modern parse
shape); the caller parses and passes the AST in. So this crate needs only
`serde_json` (plus `ryu-js` for spec-exact number printing and `rayon` for the
per-file fan-out) — no heavy compiler crate.

`shake_program_with_mono_value` is the single entry point; it takes the parsed ASTs
by reference, so the native session can retain them across builds without the
engine ever cloning the whole program.

## Build

```sh
cargo test --manifest-path packages/svelte-shaker/engine-rs/Cargo.toml
```

CI compiles and tests this crate on every Rust change
(`.github/workflows/ci-rust.yml`), together with the native addon that links it.
