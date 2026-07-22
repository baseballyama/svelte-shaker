---
'svelte-shaker': patch
---

Fix folding of prop values that JSON cannot represent. A `BigInt` prop (`<Child count={1n} />`) threw `JSON.stringify cannot serialize BigInt` out of the whole-program shake, so a single one anywhere in the graph turned the optimization into a no-op for every component. Quieter siblings of the same bug folded a prop to the wrong value instead of throwing: a `RegExp` became `{}`, `Infinity`/`NaN` became `null`, and `-0` became `0`.

`BigInt`, `RegExp`, and `-0` props are now left unfolded (one missed optimization each, never a wrong render), and `Infinity`/`-Infinity`/`NaN` fold to faithful source.
