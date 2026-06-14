---
'svelte-shaker': minor
---

ESM-only distribution and a new `verbose` option.

- **ESM only (breaking).** The package no longer ships a CommonJS build — the
  `require: './dist/index.cjs'` export is gone. `svelte-shaker` is now
  `import`-only. The distribution is also no longer bundled or minified: it is
  now a plain `tsc` transpile, one `dist/*.js` per source module, so stepping
  through `node_modules/svelte-shaker` reads the same file layout as the source
  and stack traces map straight back to readable code.
- **`verbose` option.** A one-line whole-program size summary is now always
  printed after the build crawl (e.g. `shaken 9/18 files: 16.79 kB → 15.60 kB
  (saved 1.19 kB, 7.1%)`). Set `verbose: true` to also get a per-file breakdown
  of every component that shrank. Reporting only — it never affects output.
