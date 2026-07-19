---
'svelte-shaker': minor
---

Attributes and snippet bodies a child component can never read are now removed at
every call site.

Reverse analysis: because a Svelte 5 (runes) component reads inputs only through
its `$props()` destructure, an input it does not declare — and cannot capture via
`...rest` — is invisible to it. The shaker now uses each child's reachable-input
set to delete, at every call site, the things that supply an input the child can
never observe: a side-effect-free attribute for an undeclared prop, a
`{#snippet foo}` block for a snippet the child never renders, and the body content
when the child never reads `children`. This is a whole-program deletion no
single-file tool can make — dropping `<Icon icon={Heavy}/>` when `Icon` never
reads `icon` can leave the owner's `import Heavy` unreferenced, so the bundler
drops the module.

It stays sound-first: nothing is removed when the child bailed, carries a
`...rest`, or the call site has a spread; a `bind:` directive and any value that
could have an evaluation side effect (a call, member access, template/logical
expression) are always kept.
