---
'svelte-shaker': minor
---

L2 per-call-site monomorphization is now **on by default**. It is bail-safe and never bloats (the measured net-win gate only specializes when it strictly shrinks the bundle), so leaving it on gives the most compression out of the box. To turn it off — e.g. to trade a little compression for faster builds — set `level: 1` (or `monomorphize: false`). Explicit `level: 2` / `monomorphize` configs are unaffected.
