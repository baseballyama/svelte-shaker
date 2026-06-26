---
'svelte-shaker': minor
---

Add `svelte-shaker-engine-scan-native`, an optional native (napi) prop scanner.

It parses every component with rsvelte natively (in parallel) and walks rsvelte's
**typed AST directly** — the full-AST `serde_json::Value` is never built — to compute
the whole-program never-passed-props scan that backs ESLint's `svelte/no-useless-props`.
On the flygate corpus (650 components) this runs in ~57 ms vs ~680 ms for the JS path
(~12×), with byte-identical results.

Soundness is pinned two ways: `tests/native-never-passed.test.ts` pins the typed scan
to the JS `findNeverPassedProps` (name + span, incl. non-ASCII UTF-16, rename,
namespace/barrel, spread, body), and a `scan` (typed) vs `scan_via_value` (the
reused, already-validated Value engine) vs JS corpus check confirms byte-for-byte
agreement across all 650 files. The ESLint rule prefers the addon when installed and
falls back to the JS/WASM engine otherwise.

Also parallelizes the per-file model build in the Value engine's
`find_never_passed_props` (rayon, native-only — wasm stays sequential and unchanged).
