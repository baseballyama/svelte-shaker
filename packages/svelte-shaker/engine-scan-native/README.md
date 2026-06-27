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

Plain `cargo build` produces the napi addon — `build.rs` runs
`napi_build::setup()`, so no `@napi-rs/cli` is needed. The loader (`index.cjs`)
finds the `target/{release,debug}` cdylib automatically for local dev / tests:

```sh
cargo build --release        # from this directory
```

Distribution prebuilds rename that cdylib to a platform-tagged `.node` (see the CI
workflow and Publishing below).

### rsvelte dependency

This crate depends on `rsvelte_core`, pinned in `Cargo.toml` to the exact **git
rev** the scanner is validated against. rsvelte is public, so `cargo` fetches it
with no credentials. (The CI workflow sets `CARGO_NET_GIT_FETCH_WITH_CLI=true` only
to skip rsvelte's private ecosystem-test submodules, which `rsvelte_core`'s build
doesn't use.)

For local dev against a side-by-side `rsvelte` checkout, override without editing
`Cargo.toml` via an uncommitted `.cargo/config.toml`:

```toml
[patch."https://github.com/baseballyama/rsvelte"]
rsvelte_core = { path = "../../../../rsvelte/crates/rsvelte_core" }
```

## Publishing

The package bundles every platform's `.node` and is published by the
`prebuild-native-scanner.yml` workflow (build matrix → one `npm publish`). rsvelte is
public, so the build needs no credentials; publishing uses the **`NPM_TOKEN`** repo
secret (an npm automation token).

> A raw `npm publish` did not auto-fire npm trusted-publishing OIDC here — npm never
> attempted the token exchange despite `id-token: write`, npm 11.17, and a configured
> trusted publisher (only `changesets/action`'s explicit OIDC path worked for the main
> `svelte-shaker` package). So this package uses a token. `--provenance` still uses
> `id-token: write` for the provenance attestation.

To publish: add the `NPM_TOKEN` secret, bump the version in `package.json`, then run
the workflow (`workflow_dispatch` with `publish: true`, or push a
`svelte-shaker-engine-scan-native@<version>` tag). The build matrix produces all 5
platforms' `.node`, the publish job bundles them, and `npm publish` ships one package.

For the very first publish (so the package exists), you can also publish a host-only
build manually:

```sh
# from packages/svelte-shaker/engine-scan-native, logged in to npm:
cargo build --release                                              # build.rs runs napi_build::setup()
cp target/release/libsvelte_shaker_engine_scan_native.dylib \
   svelte-shaker-engine-scan-native.darwin-arm64.node              # darwin-arm64 shown
npm publish --access public
```

(`cargo build` produces the napi addon directly; no `@napi-rs/cli` needed. The cdylib
extension is `.dylib` on macOS, `.so` on Linux, `.dll` on Windows; the `.node` tag is
`darwin-arm64` / `darwin-x64` / `linux-x64` / `linux-arm64` / `win32-x64`.)

Consumers get the speedup automatically once it is installed (e.g. as an optional
dependency); the ESLint rule loads it when present and falls back to the JS/WASM
engine otherwise.

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

## Resident daemon (`ScanDaemon`) — incremental re-scan

For an editor / LSP, parsing dominates a scan (~37 ms of the ~41 ms), so the daemon
caches each file's lightweight model (props, escapes, call sites — no AST) and
re-parses only what changed:

```js
const d = new addon.ScanDaemon();
d.init(JSON.stringify({ files, edges })); // full scan once at startup
// on edit — pass only the changed files + the full current edges:
d.update(JSON.stringify({ files: [changed], edges, removed: [deletedId] }));
```

A single-file edit re-scans in **~1.3 ms** (vs ~41 ms cold) on the 650-component
corpus, and the result is **byte-identical to a cold `scan`** (`init === scan`,
`update === scan(edited)` — pinned by `tests/native-daemon.test.ts`). It is sound to
re-parse only the changed files because a file's edges (`from == id`) derive solely
from its own imports, so an unchanged file's model can never go stale. Output keys
are sorted by file id, so cold and incremental scans agree exactly.
