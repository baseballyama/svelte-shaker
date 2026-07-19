---
'svelte-shaker': patch
---

CSS pruning now ignores class sources inside branches the shaker removes.

When computing which classes a component can produce, the shaker now excludes any
class-bearing markup that sits inside a region it deletes — a folded-away `{#if}`
arm, or a call-site input a child never reads. Previously a dynamic `class={expr}`
or a spread hiding in a dead branch made the whole component's class set
"unbounded" and blocked every `<style>` rule removal; now that source never
renders, so it no longer counts and the reachable rules can still be shaken. A
branch that collapses to a kept `{:else}` arm still counts that arm's classes, so
no rule that can match is ever removed.
