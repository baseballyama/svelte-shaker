---
"svelte-shaker": patch
---

Fix folding a prop used in a shorthand position emitting invalid output.

When a prop folded to a constant was referenced via a shorthand — `class:compact`,
`style:compact`, or the `{compact}` attribute shorthand — the shaker overwrote the
bare identifier with the literal, producing `class:false` (a *different* class than
`compact`, and observably wrong when the value is truthy), the reserved word
`{false}` (a compile error), or a dangling reference once the prop was dropped.
Each shorthand is now expanded to its explicit `name={value}` form
(`class:compact={false}`, `style:compact={false}`, `compact={false}`), matching the
already-correct full-form behavior. Closes #21.
