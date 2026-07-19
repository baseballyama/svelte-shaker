---
'svelte-shaker': patch
---

Stop the Vite plugin from triggering Rollup/Rolldown's `[SOURCEMAP_BROKEN]
Sourcemap is likely to be incorrect` warning.

When the shaker slims a component it replaces the source in its `transform` hook,
but until source-level mappings land it has no sourcemap to hand back. It now
returns the `{ mappings: '' }` sentinel for those files — the value Rollup's
`SourceMapInput` type carries to mean "no map declared", which its runtime skips
instead of flagging as a missing map — so the misleading warning no longer appears
during `vite build`.
