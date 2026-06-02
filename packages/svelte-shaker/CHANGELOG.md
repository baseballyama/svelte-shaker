# svelte-shaker

## 0.2.0

### Minor Changes

- 0baf4a8: Add opt-in incremental tree-shaking for `vite dev`.

  `vite build` is unchanged (byte-for-byte identical output). For `vite dev`, pass
  `dev: 'incremental'` (or `'coarse'`) to `shaker(...)` to shake during development
  too — the whole-program analysis now runs on a long-lived incremental engine
  that re-parses only the files you edit, and HMR is widened to the components
  whose slimmed output changed (so editing a call site correctly refreshes the
  child whose dead code that edit removed or restored). The default stays
  `dev: false` (dev is a pass-through), so existing setups are unaffected.

  Also exposes the engine boundary used by the Vite plugin — `buildAnalyzeInput`,
  `analyzeInput`, the `DevShaker` class, and the `AnalyzeInput` / `EditResult`
  types — for advanced/embedded callers.

## 0.1.1

### Patch Changes

- 14543f3: First public release of svelte-shaker — a sound, source-level tree-shaker for Svelte 5 (runes) components. It partially evaluates each `.svelte` file against how the whole app uses it (unused/constant props folded, dead `{#if}` arms and unreachable `<style>` rules removed) before the Svelte compiler runs, never changing observable behavior. Ships a Vite plugin (`svelte-shaker/vite`).
