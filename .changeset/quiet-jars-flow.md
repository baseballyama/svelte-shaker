---
'svelte-shaker': patch
---

Faster builds: the escape scan now reads, parses, and resolves the non-`.svelte` modules under `entries` in parallel instead of one file (and one import specifier) at a time. On real apps this scan can dominate the crawl, so parallelizing its file IO cuts build time with no change to what is shaken — output is byte-for-byte identical.
