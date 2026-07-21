---
'svelte-shaker': patch
---

Fold TypeScript assertion expressions (`x as T`, `x!`, `x satisfies T`) at call
sites, owner-local consts, and prop defaults, so a `<script lang="ts">` app shakes
the same whether the analyzer runs on the svelte/compiler AST (which keeps these
nodes) or the rsvelte AST (which strips them). Previously `<Child pattern={'chips'
as const} />` folded on the rsvelte path but not the svelte path, leaving the dead
`{#if pattern === 'text'}` arm and the `pattern` prop in place. These assertions
are compile-time-only type operators that erase to their operand at runtime, so
reading through them to the wrapped value is sound; the constant evaluator (and its
Rust/WASM twin) now unwrap them before evaluating.
