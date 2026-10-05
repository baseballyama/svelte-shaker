---
'svelte-shaker': patch
---

Stop crashing the build when an imported component is a virtual module

When Vite resolved a component import to an id with no file on disk — a
`\0`-prefixed virtual id, or a path whose source another plugin's `load` hook
supplies — the plugin tried to read it from disk in `buildStart` and failed
(`ENOENT`, or a null-byte path error). Such a component is now left as written.

The shaker cannot see what a virtual component renders or which props it passes,
so it can no longer prove any prop fold safe for that build. Instead of folding
against an incomplete set of call sites, it skips the shake for the build and
warns, listing the virtual ids. A virtual module that is not a component (for
example `$env/static/public` imported from a `.ts` file) does not affect the
shake.
