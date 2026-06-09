---
'svelte-shaker': minor
---

Add an opt-in `parser: 'rsvelte'` option for a ~1.46x faster build.

The Vite plugin (and `svelteShaker`'s new optional `parse` argument) can now drive the engine with rsvelte's native parser instead of svelte/compiler:

```js
shaker({ parser: 'rsvelte' }) // default stays 'svelte'
```

On a real 474-component app the full shake pipeline runs **~1.46x faster** (parse alone ~2.2x); parse dominates the pipeline (~85%), the engine's analyze+transform is only ~15%. The parser is injected once and shared between the crawl and the analysis, so each file is parsed a single time (the default svelte/compiler path actually parses twice — this is also a small win there).

Details:

- `'rsvelte'` requires the OPTIONAL peer `@rsvelte/vite-plugin-svelte-native` (`>=0.2.4`). It is **not** installed by default; add it yourself to opt in.
- The native parser is always invoked with `skipExpressionLoc: true` — the per-expression `loc` blocks roughly double the AST and make the engine's walk the bottleneck (the pipeline is actually *slower*, 0.72x, with them). The engine reads only UTF-16 `start`/`end`, never `loc`, so dropping them changes nothing in the output.
- **Soundness is parser-independent**: the engine only folds props that are never passed program-wide. Validated on a real 474-component corpus — every rsvelte-driven output compiles, and the few differences from the svelte/compiler path are all cases where rsvelte shakes *more* (a never-passed prop folded to `undefined`, a redundant attribute removed), each behavior-preserving.
- If `'rsvelte'` is requested but the native package can't be loaded (not installed, or no prebuilt binary for the platform), the plugin **throws** rather than silently falling back to svelte/compiler — a silent fallback would make the same source shake differently depending on whether the optional binary happens to be present, breaking build reproducibility.

The default (`'svelte'`) path is byte-for-byte unchanged. Requires the upstream rsvelte fixes #791/#792/#793/#916 (all released).
