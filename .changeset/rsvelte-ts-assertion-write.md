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
the engine's write analysis. The pinned rsvelte revision now includes the parser
fix. The `parser: 'svelte'` path was never affected.

`parser: 'rsvelte'` on the JavaScript engine still resolves the parser from the
published `@rsvelte/compiler`, and picks the fix up on that package's next
release.
