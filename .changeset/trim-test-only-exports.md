---
'svelte-shaker': minor
---

Trim internal, test-only symbols from the package's public entry (`svelte-shaker`). These were re-exported from the barrel but only ever imported by the engine's own tests — they were never part of the documented API, and no plugin/Node consumer used them:

- Removed the synchronous crawl entirely: `buildAnalyzeInputSync`, and the `ResolveSync` / `ReadFileSync` types. The async `buildAnalyzeInput` is the only crawl the plugin and native engine use; the sync twin had no consumer. If you were calling `buildAnalyzeInputSync`, use `await buildAnalyzeInput(...)` with async `resolve`/`readFile`.
- No longer re-exported from `svelte-shaker`: `findNeverPassedProps` / `UnpassedProp`, `analyzeInput` / `deadSpansForPlans`, `DevShaker` / `DevMode` / `DevShakerChange`, `transformAll` / `transformAllWithMono`, and `monomorphize` / `MonomorphizeResult` / `Variant` / `CallSiteBinding`. These remain available on the engine's internal modules but are no longer a supported import from the package root.

The supported surface is unchanged: the `svelte-shaker/vite` plugin, `svelte-shaker/node`, and the engine functions `svelteShaker`, `svelteShakerWithMono`, `analyze`, `buildAnalyzeInput`, plus the `DEFAULT_MONO_OPTIONS` / `MonomorphizeOptions` / `ComponentId` and related public types.
