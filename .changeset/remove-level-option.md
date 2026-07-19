---
'svelte-shaker': minor
---

**BREAKING:** The `level` plugin option was removed. The always-on passes
(unused-prop fold / constant fold / value-set narrowing) have no switch;
monomorphization is controlled solely by `monomorphize: false | { ... }`.

`level: 0|1|2` and `monomorphize` were two paths to the same on/off, and
`level: 0` vs `level: 1` never differed — a parallel API for one capability.
Now there is one knob.

Migrate:

- `level: 0` / `level: 1` → `monomorphize: false`
- `level: 2` → remove the option (monomorphization is on by default)

`monomorphize` keeps its tuning object form (`{ maxVariants, minSavings }`).
