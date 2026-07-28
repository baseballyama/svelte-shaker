---
'svelte-shaker': patch
---

Faster native builds with byte-for-byte identical output: the Rust engine now stores each component call site as a cache-friendly flat record, parses its prop writes once and reuses them in every fixpoint round, and shares that index across reverse, unread-prop, attribute-removal, and monomorphization passes instead of repeatedly walking and cloning the full AST.

The native session also moves source strings directly out of its owned JSON input instead of copying the whole program into retained storage.
