# svelte-shaker

## 0.3.0

### Minor Changes

- 40ee4d4: Require Node.js >= 22.

  Node 18 and 20 are end-of-life, so the package now declares `engines.node >= 22`
  and is tested on Node 22, 24, and 26. Installing on an older runtime will warn
  (or fail under `engine-strict`). The engine has no new runtime requirement beyond
  that — this only drops support for Node versions that no longer receive security
  updates.

## 0.2.1

### Patch Changes

- 2957ee7: Fix folding a prop used in a shorthand position emitting invalid output.

  When a prop folded to a constant was referenced via a shorthand — `class:compact`,
  `style:compact`, or the `{compact}` attribute shorthand — the shaker overwrote the
  bare identifier with the literal, producing `class:false` (a _different_ class than
  `compact`, and observably wrong when the value is truthy), the reserved word
  `{false}` (a compile error), or a dangling reference once the prop was dropped.
  Each shorthand is now expanded to its explicit `name={value}` form
  (`class:compact={false}`, `style:compact={false}`, `compact={false}`), matching the
  already-correct full-form behavior. Closes #21.

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
