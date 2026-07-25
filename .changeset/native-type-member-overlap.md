---
'svelte-shaker': patch
---

Fix the Rust (WASM/native) engine leaving a TypeScript type annotation behind when it dropped the last two members of an inline `$props()` type, making the shaken component's source differ from the TypeScript engine's (correct) output. When a component kept one prop but dropped the final inline type member whose predecessor was also dropped — e.g. `let { label, urgent, variant }: { label?: number; urgent?: boolean; variant?: string } = $props()` where only `label` survives — the engine's source editor resolved the two overlapping member removals by keeping the earlier one, so `urgent?: boolean` was left in the emitted type. The editor now unions overlapping removals exactly as `magic-string` (and hence the TypeScript engine) does, restoring byte-identical output across all three engines.

The bundled WASM engine carries this fix immediately; the optional `svelte-shaker-engine-scan-native` binary picks it up on its next release.
