---
"svelte-shaker": minor
---

Require Node.js >= 22.

Node 18 and 20 are end-of-life, so the package now declares `engines.node >= 22`
and is tested on Node 22, 24, and 26. Installing on an older runtime will warn
(or fail under `engine-strict`). The engine has no new runtime requirement beyond
that — this only drops support for Node versions that no longer receive security
updates.
