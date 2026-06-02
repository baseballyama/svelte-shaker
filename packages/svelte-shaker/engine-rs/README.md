# svelte-shaker-engine (Rust → WASM)

The Rust core of the svelte-shaker engine, compiled to WebAssembly
(`docs/RUST-MIGRATION.md` M4+). It is being ported one validated slice at a time;
each slice is pinned against the TypeScript engine by a differential test
(`packages/svelte-shaker/tests/wasm-m4.test.ts`).

## Design

**Self-contained — no `rsvelte_core` build dependency.** The crate analyzes a
Svelte component AST handed in as **JSON** (the modern parse shape). The JS side
parses (`@rsvelte/compiler` / `svelte/compiler`) and passes the AST in, so this
crate only needs `serde_json` + `wasm-bindgen` and builds to a small,
cross-platform `.wasm` — no heavy compiler crate, no native toolchain in CI.

## Build

The compiled artifact in `pkg/` is **committed** so the Node test suite (and CI)
loads it without a Rust toolchain. After editing `src/`, rebuild and commit:

```sh
pnpm --filter svelte-shaker build:wasm   # wasm-pack build --target nodejs
cargo test --manifest-path packages/svelte-shaker/engine-rs/Cargo.toml
```

> Because `pkg/` is committed and not rebuilt in CI yet, rebuilding after a source
> change is a contributor responsibility. The behavioral differential test runs
> the *committed* artifact against the TS engine, so a behavior-changing drift is
> caught; a CI job that runs `cargo test` + `build:wasm` (pinned toolchain) is a
> tracked follow-up.
