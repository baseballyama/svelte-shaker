---
'svelte-shaker': patch
---

Props forwarded through intermediate components now fold when the whole app passes
a single value.

When a component folds a prop to a constant and then forwards it to a child
(`<Child prop={prop}/>`, `<Child prop={prop === 'a' ? 'x' : 'y'}/>`, or a pure
literal expression like `prop={'a' + 'b'}`), the shaker now evaluates that
call-site expression against the owner's folded value and propagates the constant
into the child — so the child folds, drops the prop from `$props()`, and the
now-pointless attribute is removed at the forwarding site. This is a
soundness-preserving precision improvement: it only ever folds a value the app
provably passes, and value-set (narrow) forwarding is intentionally left dynamic.
