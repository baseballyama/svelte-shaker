---
'svelte-shaker': patch
---

Stop dropping slotted content passed to components that consume it through a
legacy `<slot>` or `$$slots` (both legal in Svelte 5 runes mode).

A call site like `<Wrapper let:val><Child text={val}/></Wrapper>`, where
`Wrapper.svelte` renders its content through a legacy `<slot>`, previously had its
body deleted: the reverse pass models a child's reachable inputs from its
`$props()` shape, and such a component has no `$props()` entry for the slotted
content, so the body looked unread and was removed. That changed the rendered HTML
(the slotted `<Child>` disappeared) — a soundness violation. The same held for a
component that reads `$$slots` without any `<slot>` element (e.g.
`{#if $$slots.default}…{/if}`).

A component that observes slotted content — a `<slot>` element anywhere in its
template, or a `$$slots` read in its script or template — now reports its
reachable inputs as unknown, so the reverse pass leaves every call site's body
content intact. This covers a legacy-slot component with no instance script, one
that mixes an instance script (with `$props()`) with a legacy `<slot>`, and a
`$$slots`-only component; named slots and `let:` bindings ride on the same
mechanism and are equally preserved.
