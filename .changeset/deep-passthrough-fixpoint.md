---
'svelte-shaker': patch
---

Pass-through folds now reach the deepest components of long forwarding chains.

Propagating a folded constant through intermediate components advances one hop per
analysis round, so a value forwarded down a chain longer than 10 components used
to stop short — the deepest components stayed dynamic (still correct, just less
optimized). The fixpoint iteration bound now scales with the component count, so
the fold reaches the leaf of realistically deep chains and the dead branches
behind it are removed. Shallow projects are unaffected: the analysis still stops
as soon as the plans stabilize, which is well before the bound.
