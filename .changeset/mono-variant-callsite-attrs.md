---
'svelte-shaker': patch
---

Fix monomorphization leaking a removed prop into a child's `...rest`. A
specialized copy of a component kept passing an attribute that the shaker had
removed everywhere else, because its child no longer declared that prop (the
prop was constant or never read). If the child spreads `...rest` onto an element,
the attribute showed up in the HTML: `<p v="a">a</p>` instead of `<p>a</p>`.
A component whose child call sites lose such an attribute is no longer
specialized.
