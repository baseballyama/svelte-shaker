---
'svelte-shaker': patch
---

Make the L2 net-win gate much cheaper: it now compiles only the modules whose size actually differs between the base and specialized scenarios (the variants plus any orphaned modules) instead of the whole reachable program for every candidate. Components reachable in both scenarios cancel out, so a child that orphans nothing is decided by sizing just its variants against its base. This makes a larger `maxVariants` affordable without changing any specialization decision.
