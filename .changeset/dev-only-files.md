---
'svelte-shaker': minor
---

Stop counting test and Storybook files under `entries` as component consumers by
default, and add a `devOnly` option to control which files are treated as
never-shipping.

Both directory scans previously walked every file under the `entries` roots. That
meant a colocated `Foo.test.svelte` was seeded as a call site, and a
`Button.test.ts` importing `Button.svelte` marked the component as preserved
wholesale — so a prop only a test passes was kept, and a component only a test
imported was left unshaken. The shake was still sound, but dev-only files that
never ship were pessimizing your production output.

The plugin now treats these as dev-only by default and discounts them:

```ts
devOnly: ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/__mocks__/**', '**/*.stories.*'];
```

Passing `devOnly` **replaces** this list — spread `DEFAULT_DEV_ONLY` (exported from
`svelte-shaker/vite`) to extend it, e.g. `devOnly: [...DEFAULT_DEV_ONLY, 'src/dev/**']`,
or pass `devOnly: []` to restore the previous behavior of counting every file.
Patterns are matched with `picomatch` against each file's path relative to the
Vite root.

List only files that never ship: a matched file stops counting as a consumer (as a
seed and in the escape scan), but a `.svelte` file the app actually imports is still
crawled and shaken through the normal graph, so its real call sites still count.

The `svelte-shaker/node` helpers follow the same default: `collectSvelteFiles(dir)` and
`computeEscapedComponents({...})` now apply `DEFAULT_DEV_ONLY` when no filter is passed.
Standalone callers who want the previous scan-everything behavior pass an explicit
empty filter — `compileDevOnly(dir, [])` (or `devOnly: compileDevOnly(root, [])`).
