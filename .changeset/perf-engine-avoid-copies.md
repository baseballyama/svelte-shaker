---
'svelte-shaker': patch
---

Faster builds with byte-for-byte identical output — the engine skips redundant copying and re-rendering during the whole-program pass:

- Monomorphization now renders each child's specialized source once per distinct call-site shape instead of once per call site, so a component used at many identical call sites is shaken once rather than repeatedly.
- The whole-program shake no longer deep-copies the resolved edge set on every run, and the native prop scan no longer deep-copies the whole-program source input on every invocation (nor the per-file source of ASCII components, which never need it).

The bundled WASM engine carries these immediately; the optional native (`svelte-shaker-engine-scan-native`) binary picks up its share on its next release.
