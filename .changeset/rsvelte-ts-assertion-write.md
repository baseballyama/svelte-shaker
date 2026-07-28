---
'svelte-shaker': patch
---

Fix the native engine missing a write made through a TypeScript non-null
assertion (`count!++`, `count! += 1`), which let it fold a prop that is not
constant. A component like `<Child n={count} />` whose owner wrote `count!++`
had `n` folded to its initial value and the prop deleted, so the child stopped
re-rendering when the counter changed — the rendered output differed from the
unshaken build. The cause was upstream: rsvelte's parser serialized an
assignment target carrying a TS assertion as `null`, so the write never reached
the engine's write analysis. The bundled `@rsvelte/compiler` is now 0.9.4, and
the native engine's `rsvelte_core` pin uses the same compiler source plus a
Cargo-only submodule metadata fix. Both include the parser fix. The
`parser: 'svelte'` path was never affected.
