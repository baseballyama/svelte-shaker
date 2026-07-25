---
'svelte-shaker': minor
---

Remove the WASM engine. The shake now runs on the **native (napi) Rust engine** when
a prebuilt binary loads, and the **JS engine** otherwise — two tiers instead of three.
Both are differentially tested to produce **byte-identical** output, so nothing about
what ships changes.

Why: once native prebuilts covered darwin/linux/win, WASM was only ever selected for
"no prebuilt binary **and** a mid-sized app", where it beat the JS engine on speed
alone. That narrow slice did not justify a 382 kB committed artifact in every install
plus a third engine to keep at parity. Dropping it cuts the published tarball from
**314 kB to 139 kB** (unpacked 858 kB → 436 kB).

**Migration**

- **`engine: 'wasm'` was never a valid value** — no change needed if you never set
  `engine`.
- **`engine: 'rust'`** now means the native engine only. It previously fell back to
  WASM when no prebuilt binary existed; it now **throws** instead, naming
  `engine: 'js'` as the way out. If you set `engine: 'rust'` and build on a platform
  without a prebuilt binary, switch to `engine: 'auto'` (the default, which falls back
  to JS automatically) or `engine: 'js'`.
- **`parser`** now applies only to the JS engine and defaults to `'svelte'`
  (svelte/compiler). Previously the default *followed the engine*, so the WASM engine
  parsed with rsvelte; with WASM gone there is no engine whose default is `'rsvelte'`.
  Set `parser: 'rsvelte'` explicitly if you want it — note it forces the JS engine.
  Output is byte-identical either way.
- The undocumented `svelteShakerWasm` / `svelteShakerWasmWithMono` exports and the
  `build:wasm` script are gone.

The ~300-component size gate that routed large apps away from WASM is removed with it:
the native engine never had a size ceiling, so `auto` now picks native regardless of
app size.
