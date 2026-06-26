---
'svelte-shaker': minor
---

Add `findNeverPassedProps(input)` and a synchronous `buildAnalyzeInputSync` for
lint-style dead-code reporting.

`findNeverPassedProps` returns, per component, the declared props that NO call
site in the analyzed program ever passes (explicitly, via `bind:`, via a spread,
or as body/`{#snippet}` content) — props the component declares but no consumer
supplies. It only reports high-confidence cases, mirroring the folder's caution:
bailed/escaped components and components with zero call sites (entries, SvelteKit
route pages whose props are framework-injected) are skipped, and an incomplete
crawl can only under-report (never false-positive). Each result carries the
prop's source span for direct mapping by a consumer such as an ESLint rule.

`buildAnalyzeInputSync` is a synchronous twin of `buildAnalyzeInput` (sync
`resolve`/`readFile`) for callers that cannot await — e.g. an ESLint rule, which
runs synchronously. A differential test pins it byte-identical to the async
crawl. `deadSpansForPlans` is now exported too.
