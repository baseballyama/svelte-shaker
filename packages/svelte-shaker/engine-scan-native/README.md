# svelte-shaker-engine-scan-native

Optional **native (napi) prop scanner** for svelte-shaker — the fast path behind
ESLint's [`svelte/no-useless-props`](https://github.com/sveltejs/eslint-plugin-svelte).

It parses every component with **rsvelte natively, in parallel (rayon)** and walks
rsvelte's **typed AST directly** — the full-AST `serde_json::Value` (the ~12 MB
template skeleton) is never built — so the whole-program scan no longer parses in
JS, ships a serialized AST across the JS boundary, or materializes the AST as JSON
at all.

```
buildAnalyzeInputSync (JS crawl: resolve edges, read files)
        │  { files: [{id, code}], edges }   (JSON string)
        ▼
   scan()  ── rayon ─▶ rsvelte parse ─▶ typed-AST walk (no Value)
        │
        ▼  { fileId: [{name, start, end}] }  (JSON string, UTF-16 offsets)
```

### Two layers, both exhaustive

never-passed needs far less than a full model: `find_never_passed_props` only tests
`had_spread || explicit.contains(name)`, so a call site is just `{ had_spread,
explicit: set<name> }` — no literal values, value sets, defaults, `local`, or
shadow/debug names. So `scan` (`typed_scan.rs`) walks:

- The **template** over the typed `TemplateNode` enum. An exhaustive `match` makes a
  forgotten node kind a COMPILE error — a node can never be silently skipped (which
  could drop a call site or an escape and cause a false positive).
- **JS expressions** (the small instance `<script>` + each embedded template
  expression) via rsvelte's `as_json()`, walked generically — `serde_json` visits
  every child, so escape detection (the one analysis whose incompleteness would
  cause a false positive) is provably exhaustive. rsvelte exposes no typed JS-AST
  walker, and rsvelte_lint itself reads the JS AST as JSON; a hand-rolled per-variant
  JS walker would risk exactly the missed-variant false positives this rule forbids.

`scan_via_value` keeps the Value-engine path (serialize each AST and run
`svelte_shaker_engine::find_never_passed_props`) as the differential **oracle** for
`scan` and as a drop-in fallback.

## Soundness

The output is **pinned byte-for-byte to the JS engine**, two ways:

- `tests/native-never-passed.test.ts` pins `scan` (typed) against the TS
  `findNeverPassedProps` — name **and** span, including non-ASCII source (UTF-16
  remap), rename, namespace/barrel edges, spread, and body/snippet cases.
- The corpus benchmark pins `scan` (typed) === `scan_via_value` (oracle) === the JS
  engine on the full flygate corpus (650 components): same 18 files, same 53 reports,
  zero diffs. The oracle path reuses `svelte_shaker_engine::find_never_passed_props`,
  which is itself pinned to the TS engine by the `wasm-never-passed` test.

A parse error on any file yields no model for it (it is silently skipped), so a
broken file can only ever make the scan **under-report**, never produce a false
positive.

## Build

Local dev / tests build straight off cargo — the loader (`index.cjs`) finds the
`target/{release,debug}` cdylib automatically:

```sh
cargo build --release        # from this directory
```

Distribution prebuilds use [`@napi-rs/cli`](https://napi.rs):

```sh
pnpm build                   # napi build --platform --release --no-js
```

### rsvelte dependency

This crate depends on `rsvelte_core`. Locally it is a **path** dependency (see
`Cargo.toml`), which is why `cargo build` works straight from a side-by-side
`rsvelte` checkout. For CI prebuilds, pin it to a **git rev** instead — rsvelte is
private, so the prebuild workflow needs a deploy token / SSH key for
`cargo`'s git fetch (`CARGO_NET_GIT_FETCH_WITH_CLI=true` + credentials).

## Performance

On the flygate corpus (650 components, Apple Silicon, release build), warm, full
`scan` (input JSON in -> report JSON out):

| path                        | median | min    |
| --------------------------- | ------ | ------ |
| **`scan` (typed, default)** | **~57 ms** | **~49 ms** |
| `scan_via_value` (oracle)   | ~297 ms | ~277 ms |

vs. the JS path (svelte/compiler parse + JS analyze) at ~680 ms. The typed path is
~5× faster than the Value path and hits the ~50 ms target, with byte-identical
results. (`scanProfile()` returns the typed-vs-Value split.)

The escape-detection parent-context subtlety — a top-level `{X}` counts as a
value-use only because its parent is an `ExpressionTag` — is handled in
`expression_escapes`: each embedded expression is walked with its root treated as a
value position (it always sits in one in the template), matching the engine's
whole-tree walk. The corpus oracle confirms this is exact.
