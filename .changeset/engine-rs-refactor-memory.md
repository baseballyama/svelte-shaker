---
'svelte-shaker': patch
---

Lower peak memory during the whole-program shake, with byte-for-byte identical output: the Rust engine's per-component IR no longer keeps a second full copy of the parsed AST (plus the instance and module scripts) alongside the one the model already owns — it now holds only the template fragment it re-walks each fixpoint round. On a large app this drops the retained AST memory roughly in half during the build.

The bundled WASM engine carries this immediately; the optional native (`svelte-shaker-engine-scan-native`) binary picks it up on its next release.
