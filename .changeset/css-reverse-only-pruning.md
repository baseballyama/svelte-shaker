---
'svelte-shaker': patch
---

CSS pruning now fires for components that only have inputs removed, not folded.

A component that folds or narrows nothing — but whose body still has a call-site
input a child never reads (or an unread declared prop) removed — used to skip CSS
pruning entirely. So when the removed region was the only home of an unbounded
class source (`class={dynamic}`, `{...rest}`), the class set stayed "unbounded"
and no `<style>` rule could be shaken, even though that source no longer renders.
The shaker now prunes CSS on that path too, using the removed region as the
excluded set. This only ever removes a rule whose class the component provably
cannot produce; a component with nothing removed is left byte-identical.
