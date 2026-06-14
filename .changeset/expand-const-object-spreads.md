---
'svelte-shaker': minor
---

Expand statically-known object-literal spreads at call sites (`<Comp {...{ a: 1, b: 2 }} />`). Such a spread's full key set is visible, so its keys are now folded exactly as if written as attributes (`a={1} b={2}`), instead of being treated as an opaque spread that poisons every prop it might set. Opaque spreads (`{...someVar}`, or object literals carrying a nested spread / computed key / accessor) are unchanged — they still bail conservatively.
