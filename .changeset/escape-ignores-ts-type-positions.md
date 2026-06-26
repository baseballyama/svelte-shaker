---
'svelte-shaker': patch
---

Stop the escape analysis from descending into TS type-only subtrees, so a
component named in a *type* position is no longer falsely bailed. A reference
like `ComponentProps<typeof Button>['pattern']` (or a `: Props` annotation) names
`Button` only at the type level — erased at compile, never a runtime value read —
but the escape walk treated that identifier as a value use and bailed the whole
component, leaving it (and every component referenced the same way) un-shaken
under the default `svelte` parser.

The walk now skips `TSType*` nodes and `interface` declarations in both the JS
and native Rust engines (output stays byte-identical). Real value escapes
(`const C = Button`, `<svelte:component this={Button}>`, `Button as T`) are
unaffected. This closes the gap where `parser: 'rsvelte'` shook a superset: on a
large real app the default parser now matches it exactly (same files shaken, same
bytes saved).
