---
'svelte-shaker': patch
---

Fix invalid output when a folded numeric prop is used as a member-access object. `count.toLocaleString()`, with `count` folded to `5000`, emitted `5000.toLocaleString()` — the parser reads `5000.` as a float and fails (`Identifier directly after number`). The number is now parenthesized (`(5000).toLocaleString()`). Previously such a component made the whole build fall back to re-running the transform, so this also removes that wasted work.
