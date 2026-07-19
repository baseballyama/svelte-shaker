<p align="center">
  <img src="./assets/logo.png" alt="svelte-shaker" width="190" />
</p>

<h1 align="center">svelte-shaker</h1>

<p align="center">
  <strong>A sound, source-level tree-shaker for Svelte&nbsp;5 (runes) components.</strong>
</p>

**▶ Try it in the browser: https://baseballyama.github.io/svelte-shaker/** — the
playground runs the engine entirely client-side.

svelte-shaker runs in your production build, **before** the Svelte compiler, and
slims each `.svelte` file by partially evaluating it against how your **whole
app** actually uses it: props no call site passes (or that always receive the
same value) are folded to their constant, the dead `{#if}` arms behind them are
deleted, the props are dropped from `$props()`, the attributes are removed at
every call site, and `<style>` rules whose class can never be produced are
stripped.

It is **sound first**: it never changes what renders. When a transform can't be
proven safe, the code is left untouched (bails).

## Why a JS bundler can't do this

Design-system components carry many props (`variant / size / loading / icon …`),
but any one app uses only a few. The code behind the unused props still ships,
because Svelte emits **one generic JS module per component**, shared by every
caller: prop values flow through the runtime, so terser/Rollup can never fold
`if (loading)` to `if (false)`, and nothing in the pipeline knows which props
your app never uses. svelte-shaker works one step earlier, on the pre-compile
source, where call-site values and template structure are still visible.

The clearest win is CSS: given `class="btn btn-{variant}"` where the app only
ever passes `primary` / `secondary`, the class `btn-danger` can never exist at
runtime — but it only appears as a runtime string, so neither Svelte's own
unused-CSS pruning nor the bundler can prove that. svelte-shaker computes the
reachable value set of `variant` and removes the `.btn-danger` rule.

## Install

```sh
npm i -D svelte-shaker   # requires svelte@^5
```

## Usage (Vite)

Add the plugin **before** `svelte()`. It runs only in `vite build` — dev/HMR is
a pass-through by design.

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { shaker } from 'svelte-shaker/vite';

export default defineConfig({
  plugins: [
    // `include` must cover EVERY call site in the app, or prop elimination
    // would be unsound. Defaults to the Vite root.
    shaker({ include: ['src'] }),
    svelte(),
  ],
});
```

For non-Vite pipelines there is a plain-Rollup plugin
(`rollup-plugin-svelte-shaker`).

### Options

```ts
shaker({
  include: ['src'], // dirs (relative to root) holding every .svelte call site
  level: 2, // 0 | 1 | 2 — default 2; `level: 1` turns L2 off for faster builds
  monomorphize: true, // L2 tuning; or { maxVariants: 16, minSavings: 0.15 }
  engine: 'auto', // 'auto' (default) | 'js' | 'rust'
  parser: 'svelte', // 'svelte' (default) | 'rsvelte'
  verbose: false, // true = per-file size breakdown after the build
});
```

- **`engine`** — which engine runs the shake. `'auto'` uses the native Rust
  (WASM) engine when it can be loaded, else the JS engine. Both are
  differentially tested to produce **byte-identical** output, so the choice only
  affects speed. `'rust'` throws if the WASM module can't load.
- **`parser: 'rsvelte'`** — swaps in [rsvelte](https://github.com/rsvelte/rsvelte)'s
  native Rust parser: **~1.46x** faster full build (parse alone ~2.2x) on a real
  474-component app. Requires the optional peer
  `@rsvelte/vite-plugin-svelte-native`; if it can't be loaded the plugin
  **throws** instead of silently falling back, so the same source always shakes
  the same on every machine. Soundness is parser-independent.
- **L2 never bloats** — a measured net-win gate only specializes a component
  when that strictly shrinks the whole program, so its only cost is build time.

## What it removes

| Level    | What it removes                                                                                                                              | Default |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **L0**   | Props no call site ever passes → fold to the default, drop from `$props()`, strip the attribute at call sites                                | on      |
| **L1**   | Props that collapse to one constant app-wide → fold + drop + strip every call site's attribute                                               | on      |
| **L1.5** | Value-set **narrowing**: with `variant ∈ {primary, secondary}`, delete provably-dead `{#if}`/`{:else if}` arms (prop stays in the signature) | on      |
| **CSS**  | `<style>` rules whose class can never be produced given the value sets                                                                       | on      |
| **L2**   | Per-call-site monomorphization: specialize a component per prop shape (deduped by residual, capped by `maxVariants`)                         | on (`level: 1` to disable) |

Folding also reaches template ternaries (`{cond ? a : b}`) and class-string
interpolation when the parts are provable constants.

## Soundness

The whole point is to **never change observable behavior**.

- **Differential-SSR verified** — tests server-render the original and the
  shaken component and assert the HTML is identical for every value the app
  actually passes.
- **Conservative bail** — anything unprovable is left as-is. Whole-component:
  `<svelte:options accessors />` / `customElement`, components that escape as a
  value, or are imported through a barrel (call sites not enumerable). Per-prop:
  spread, callee `...rest`, `bind:`, shadowing, `{@debug}`.
- **Side effects preserved** — an attribute or value is only removed when it is
  provably pure and unused.
- **Whole-program fixpoint** — call sites inside deleted branches don't count
  toward a child's prop profile.

## Limitations

- **Svelte 5 runes only** — Svelte 4 (`export let` / `$:` / `$$props`) is out of
  scope.
- **Needs `.svelte` source** — libraries shipping compiled JS pass through
  unshaken; distribute via `svelte-package`.
- **Build only** — whole-program analysis is incompatible with dev/HMR locality,
  so dev is always a pass-through.
- **`include` must cover the whole app** — a call site outside the scanned dirs
  is invisible, which would make prop elimination unsound.

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full design and
implementation status.

## License

MIT
