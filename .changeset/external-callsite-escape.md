---
'svelte-shaker': minor
---

Never fold a component's props when a `.ts`/`.js` module uses it, and add an
`external` option to freeze components by hand.

The shake only reads `.svelte`, so a call site in a plain module — `mount(Component,
{ props })`, `render(...)`, a lazy `import('./X.svelte')` — used to be invisible.
A component used from **both** a `.svelte` template and a `.ts` module could have a
prop folded to its default even though the module passed it, changing what you see.

The Vite plugin now scans your non-`.svelte` modules under `include` and freezes any
component reached by a static import, `export … from`, or a literal
`import('./X.svelte')` — so ordinary `mount(...)` call sites are handled for you, in
both `vite build` and incremental dev.

For the cases the scan can't follow — a **non-literal** dynamic `import(expr)`, or a
call site in a module outside `include` — the new `external` option freezes named
components: `shaker({ include: ['src'], external: ['src/widgets/Chart.svelte'] })`.
Entries are root-relative or absolute paths naming a component file or a directory
of them. `external` freezes the component only — the file stays fully analyzed and
its own call sites keep counting; it is not a way to exclude a file from the scan.
