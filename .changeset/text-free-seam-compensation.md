---
'svelte-shaker': patch
---

Fix a build failure when a folded `{#if}` chain sits directly inside a text-free
parent (`<table>`/`<thead>`/`<tbody>`/`<tfoot>`/`<tr>`/`<colgroup>`). The seam
compensation used to overwrite the removed chain with a `{" "}` expression tag to
preserve a separating space, but inside those elements Svelte's
`is_tag_valid_with_parent('#text', …)` rejects a text child outright
(`<#text> cannot be a child of <tr>`), and the whitespace rendered nothing there
to begin with. The transform now threads the nearest content-model parent element
(mirroring svelte's `parent_element` reset rules) and falls back to plain deletion
in those parents, so a shaken component always compiles. Applied in both the JS
and native Rust engines (output stays byte-identical, pinned by a new regression
test).
