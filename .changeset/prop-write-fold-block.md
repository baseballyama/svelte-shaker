---
'svelte-shaker': patch
---

fix: never fold a prop the component writes to (soundness)

A prop that the component reassigns (`p = …`), mutates (`p++`), destructure-assigns
(`({ p } = obj)`), or two-way binds (`bind:value={p}`) is not a constant, even when
every call site passes the same literal — the write changes it at runtime. Such props
are no longer const-folded, so the value seen after the write, and the call-site
attribute that supplies the initial value, are both preserved. As an extra safety
net, if a transform ever emits source that fails to re-parse, the shaker now reverts
the whole affected component graph together instead of just the broken file, so a
child and its parent can never end up in an inconsistent state.
