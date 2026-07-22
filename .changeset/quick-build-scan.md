---
'svelte-shaker': minor
---

Add an `exclude` option and make the build crawl much faster on real apps.

- **New `exclude` option** — directories the scans must not walk, for a compiled/generated tree that is not source (a SvelteKit adapter's `build/`, a `dist/`). The resolved Vite `build.outDir` is now always excluded automatically; add other output dirs (most importantly adapter-static `build/`, which lives outside `build.outDir`) via `exclude: ['build']`. Left unpruned, the escape scan parses megabytes of minified build output looking for call sites it can never contain, which can dominate the crawl. Like `entries`, over-listing errs unsafe, so name only generated output, never source.
- **Faster whole-program crawl** — a shared barrel (a design-system `index.ts` re-imported by hundreds of components) is now read and parsed once per build instead of once per call site, and monomorphization skips its whole-program size setup when nothing is specializable. No change to what is shaken; output is byte-for-byte identical.
