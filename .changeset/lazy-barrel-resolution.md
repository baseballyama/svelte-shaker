---
'svelte-shaker': patch
---

Resolve barrels lazily during the crawl. A `.js`/`.ts` re-export ("barrel") was
read and parsed for **every** named import to chase the export, even for
value-only imports (helpers, types) that are never rendered as a component. Now a
barrel is followed only for a named import actually rendered as `<Local>` here —
a value-only import can never be a call site, so skipping it leaves attribution
(and every model) unchanged. On a ~650-component app this cut the whole-program
crawl roughly 3-4x (most of the time was parsing modules behind value-only
imports), with byte-identical analysis output.
