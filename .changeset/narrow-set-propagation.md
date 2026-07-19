---
'svelte-shaker': patch
---

Value sets now flow through pass-through call sites.

Building on the folded-constant forwarding, a prop the app narrows to a known
reachable set (`variant ∈ {primary, secondary}`) now propagates that whole set
into a child it is forwarded to verbatim (`<Child variant={variant}/>`). The
child's own value-set narrowing then fires across the component boundary — dead
`{#if}` arms and provably-unmatchable `<style>` rules are removed in the child
too, not just in the component that originally passed the prop. Only a bare
forwarded prop propagates a set; a compound expression over it stays dynamic. As
before this is soundness-preserving: it only ever contributes values the app
provably passes.
