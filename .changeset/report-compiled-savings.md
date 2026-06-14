---
'svelte-shaker': minor
---

The `verbose` size report now also prints the compiled-output (client JS + scoped CSS) byte savings for the shaken files, not just the pre-compile source-byte delta. A folded dead branch or a removed `<style>` rule shrinks the shipped output far more than its few source bytes suggest, so this is a truer picture of what the shake saves. Reporting only — it never affects the build output.
