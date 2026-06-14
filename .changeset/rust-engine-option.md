---
'svelte-shaker': minor
---

Add an `engine` option (`'auto' | 'js' | 'rust'`, default `'auto'`) to run the L0/L1/L1.5 analysis + transform in the native Rust (WASM) engine. The Rust engine is differentially tested to produce byte-identical output to the JS engine, so the choice only affects build speed, never what is shaken. `'auto'` uses the Rust engine on the L2-off path and falls back to JS otherwise; `'rust'` forces it (L2 is JS-only and is skipped); `'js'` forces the JS engine. The WASM artifact now ships inside the package.
