---
'svelte-shaker': patch
---

Depend on `svelte-shaker-engine-scan-native@~0.4.0`, the native engine release that speaks the engine API the plugin expects. 0.18.1 depended on `~0.3.0`, whose binary reports engine API 3, so the plugin always rejected it: `engine: "auto"` silently fell back to the JS engine and `engine: "rust"` failed to load.
