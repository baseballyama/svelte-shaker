---
'svelte-shaker': patch
---

Faster builds on large apps — the same output, chosen and produced more cheaply:

- `engine: 'auto'` now keeps a large app (more than a few hundred components) on the JS engine. The native engine parses faster but marshals the whole-program AST across the JS↔WASM boundary as JSON; past that size the round-trip costs more than the parse saves. `engine: 'rust'` still forces the native engine.
- The default `parser` now follows the engine: rsvelte on the native engine (its AST feeds Rust directly), svelte/compiler on the JS engine, where rsvelte's parse was ~2x slower pure overhead. Pin either with the `parser` option.
- Monomorphization's net-win gate reuses the AST the analysis already produced for every file it did not fold, instead of re-parsing all of them.

All three are speed-only: the shaken output is byte-for-byte unchanged.
