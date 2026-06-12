---
'svelte-shaker': patch
---

fix: removing a dead `{#if}` chain (or collapsing it to its kept arm) no longer changes the rendered whitespace. A space could be lost where the chain separated two nodes (the surviving whitespace fell to a fragment edge and was trimmed), or gained from the kept arm's own edge whitespace. The chain's seam is now compensated with `{" "}` only when a space would otherwise be lost, the kept arm's leading/trailing whitespace is stripped when spliced, and whitespace inside `<pre>`/`<textarea>` (or under `preserveWhitespace`) is left byte-exact.
