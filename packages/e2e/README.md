# e2e

Differential end-to-end SSR harness for svelte-shaker.

## What it is

Builds a realistic Svelte 5 app **twice** — once with the shaker, once without — then
server-renders both bundles and asserts byte-equal HTML.  A mismatch or a runtime error
in the shaken bundle is a soundness violation.

The app exercises 13 patterns (shorthand fold, aliased destructure, nested destructure,
rest props, multi-call-site constants, ternary fold, CSS stripping, snippets, `$bindable`,
dynamic component, TypeScript-typed props, barrel re-export, and the real `mode-watcher`
`ModeWatcher` component) plus a client-build smoke test.

## How to run

```sh
# Build the engine first (required — the engine is a workspace dep).
pnpm build

# Run the differential test.
pnpm --filter e2e test
```

The test is **expected to fail** until issue #37 (aliased-prop fold drops the alias
binding without replacing its uses) is fixed.  The failure is the proof the harness works.
