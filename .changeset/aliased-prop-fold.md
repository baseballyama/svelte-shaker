---
'svelte-shaker': patch
---

fix: aliased `$props()` destructuring (`prop: alias = default`) no longer breaks builds — references to the alias were left dangling and a same-named import could be corrupted (#37). Folds now substitute the local binding name and leave colliding imports untouched. Props bound to a nested pattern (`prop: { x }`) are now left alone instead of being folded.
