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
but any one app uses only a few — yet the code behind the unused props still
ships. A minifier _can_ fold a component-local constant (it compiles to plain
JS). A prop is different: Svelte emits **one generic JS module per component**,
shared by every caller, and the prop's value reaches it through runtime
indirection (`$.prop(...)`), so turning `if (loading)` into `if (false)` would
take constant propagation across component boundaries — something neither
Rollup nor terser performs, even when every call site passes the same literal.
svelte-shaker works one step earlier, on the pre-compile source, where
call-site values and template structure are still visible.

The clearest win is CSS: given `class="btn btn-{variant}"` where the app only
ever passes `primary` / `secondary`, the class `btn-danger` can never exist at
runtime — but it only appears as a runtime string, so neither Svelte's own
unused-CSS pruning nor the bundler can prove that. svelte-shaker computes the
reachable value set of `variant` and removes the `.btn-danger` rule.

## Install

```sh
npm i -D svelte-shaker @rsvelte/vite-plugin-svelte-native   # requires svelte@^5
```

`@rsvelte/vite-plugin-svelte-native` is a required peer: by default the plugin
parses with rsvelte's native Rust parser (the fast path — see
[Options](#options)). Install it on every platform your build runs on. If you
can't, set `parser: 'svelte'` to fall back to svelte/compiler.

## Usage (Vite)

Add the plugin **before** `svelte()`. It runs only in `vite build` — dev/HMR is
a pass-through by design. Out of the box it runs the native **Rust (WASM)
engine** and parses with the native **rsvelte** parser; both fall back cleanly
(see [Options](#options)).

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

For plain-Rollup pipelines, wire the shake up yourself with the public engine
API (`svelte-shaker`) and the file-system helpers in `svelte-shaker/node`. Note
that monomorphization additionally needs the `?shaker_variant` requests routed
through your plugin's `resolveId`/`load` hooks; the unused-prop fold / constant
fold / value-set narrowing shake only needs the `transform` swap. The
environment-free engine and the in-browser playground parse with svelte/compiler
(no native binary to require) — the rsvelte default is a Vite-plugin concern; the
engine takes an optional `parse` argument if you want to swap it.

### Options

```ts
shaker({
  include: ['src'], // dirs (relative to root) holding every .svelte call site
  monomorphize: true, // default on; `false` disables it for faster builds,
  // or { maxVariants: 16, minSavings: 0.15 } to tune
  verbose: false, // true = per-file size breakdown after the build

  // Escape hatches — the defaults ARE the fast Rust path; set these only to opt
  // out (e.g. if you ever hit a bug in it).
  engine: 'auto', // 'auto' (default: Rust/WASM, else JS) | 'js' | 'rust'
  parser: 'rsvelte', // 'rsvelte' (default: native parser) | 'svelte' (fallback)
});
```

- **The defaults are the Rust fast path.** Out of the box svelte-shaker runs the
  native **Rust (WASM) engine** and parses with **rsvelte**'s native parser
  ([`@rsvelte/vite-plugin-svelte-native`](https://github.com/rsvelte/rsvelte)),
  which is **~1.46x** faster full build (parse alone ~2.2x) on a real
  474-component app. Both are differentially tested to shake **byte-identically**
  to the JS engine / svelte/compiler, and soundness is independent of either
  choice — the fast path never changes what renders, only how fast it gets there.
- **`monomorphize`** — the one shaking knob, **on** by default. A measured
  net-win gate only specializes a component when that strictly shrinks the whole
  program, so monomorphization **never bloats**; its only cost is build time. Set
  `monomorphize: false` to skip it for faster builds, or pass
  `{ maxVariants, minSavings }` to tune.
- **Escape hatches (`engine` / `parser`).** If you ever hit a bug in the Rust
  path, opt out per axis: `engine: 'js'` forces the JS engine, `parser: 'svelte'`
  forces svelte/compiler (the previous default). When the default `parser:
  'rsvelte'` peer can't be loaded (not installed, or no binary for this platform)
  the plugin **throws** rather than silently falling back — so the same source
  always shakes the same on every machine. Install the peer everywhere your build
  runs, or set `parser: 'svelte'`.

## What it removes

| Pass                    | What it removes                                                                                                                              | Default |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **unused-prop fold**    | Props no call site ever passes → fold to the default, drop from `$props()`, strip the attribute at call sites                                | on      |
| **constant fold**       | Props that collapse to one constant app-wide → fold + drop + strip every call site's attribute                                               | on      |
| **value-set narrowing** | With `variant ∈ {primary, secondary}`, delete provably-dead `{#if}`/`{:else if}` arms (prop stays in the signature)                          | on      |
| **CSS**                 | `<style>` rules whose class can never be produced given the value sets                                                                       | on      |
| **monomorphization**    | Per-call-site: specialize a component per prop shape (deduped by residual, capped by `maxVariants`)                                          | on (`monomorphize: false` to disable) |

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
