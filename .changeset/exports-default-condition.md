---
'svelte-shaker': patch
---

Add a `default` export condition so the package can be loaded via `require()` on
Node ≥22.12 (synchronous `require(ESM)`). Previously the exports map only
declared `import`, so a synchronous CommonJS consumer — notably an ESLint rule
calling `require('svelte-shaker')` — hit `ERR_PACKAGE_PATH_NOT_EXPORTED`. ESM
consumers are unaffected (they still resolve via `import`).
