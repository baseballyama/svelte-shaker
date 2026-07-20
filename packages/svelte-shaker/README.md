<p align="center">
  <img src="https://raw.githubusercontent.com/baseballyama/svelte-shaker/main/assets/logo.png" alt="svelte-shaker" width="190" />
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
npm i -D svelte-shaker   # requires svelte@^5
```

Nothing else to install. By default the plugin parses with rsvelte, loaded from
`@rsvelte/compiler` (a bundled WASM dependency — no peer, no platform-specific
binary). `parser: 'svelte'` falls back to svelte/compiler if you ever need it
(see [Options](#options)).

## Usage (Vite)

Add the plugin **before** `svelte()`. It runs only in `vite build` — dev/HMR is
a pass-through by design. Out of the box it runs the native **Rust (WASM)
engine** and parses with **rsvelte**; both fall back cleanly (see
[Options](#options)).

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { shaker } from 'svelte-shaker/vite';

export default defineConfig({
  plugins: [
    // `entries` is where the component crawl STARTS, not a file filter. It
    // must cover EVERY call site in the app, or prop elimination would be
    // unsound. Defaults to the Vite root.
    shaker({ entries: ['src'] }),
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
— the rsvelte default is a Vite-plugin concern (it loads a Node-only WASM
module); the engine takes an optional `parse` argument if you want to swap it.

### Options

```ts
shaker({
  entries: ['src'], // dirs (relative to root) the crawl starts from; they must
  // hold every .svelte call site in the app. Not a glob, not a filter.
  preserve: [], // components whose props must never be folded (see below)
  monomorphize: true, // default on; `false` disables it for faster builds,
  // or { maxVariants: 16, minSavings: 0.05 } to tune
  verbose: false, // true = per-file size breakdown after the build

  // Escape hatches — the defaults ARE the Rust path; set these only to opt
  // out (e.g. if you ever hit a bug in it).
  engine: 'auto', // 'auto' (default: Rust/WASM, else JS) | 'js' | 'rust'
  parser: 'rsvelte', // 'rsvelte' (default) | 'svelte' (fallback)
});
```

That list is exhaustive: any other key **fails the build**, naming the key and the
options that do exist. A typo would otherwise be ignored — and a misspelled
`preserve` ships the component you meant to protect, over-shaken.

- **The defaults are the Rust path.** Out of the box svelte-shaker runs the
  native **Rust (WASM) engine** and parses with **rsvelte**, loaded from
  [`@rsvelte/compiler`](https://github.com/baseballyama/rsvelte) (a bundled WASM
  dependency — nothing to install). The Rust (WASM) engine is differentially
  tested to shake **byte-identically** to the JS engine. The parser choice is
  **soundness-neutral**: the engine reads only UTF-16 `start`/`end`, so
  svelte/compiler and rsvelte are differentially tested to produce
  **SSR-equivalent** output — the choice never changes what renders. rsvelte is
  the default as the Rust parser the pipeline is standardizing on (end-to-end
  Rust with the WASM engine); `parser: 'svelte'` stays available as the
  fallback.
- **`monomorphize`** — the one shaking knob, **on** by default. A measured
  net-win gate only specializes a component when that strictly shrinks the whole
  program, so monomorphization **never bloats**: whatever the knobs are set to,
  a build with `monomorphize` on is never larger, byte for byte, than the same
  build with it off (the 3 always-on passes alone). The knobs only trade off how
  much specialization is *attempted* against build time:
  - `maxVariants` (default `8`) — cap on distinct residual variants per
    component. A child whose call sites produce more distinct shapes than the
    cap can't be specialized at every site, so it keeps its base entirely
    (all-sites-or-nothing — no partial split). Raise it for a large
    design-system component (e.g. a `Button` used with more than 8 prop shapes
    app-wide) you know is worth specializing further.
  - `minSavings` (default `0`, i.e. any strict net reduction) — the net-win
    threshold: a specialization is applied only when it measures
    `Σ_spec < Σ_base × (1 − minSavings)`. Raising it only makes the gate more
    conservative (fewer, bigger wins, faster builds) — no value makes
    monomorphization unsound.

  ```ts
  monomorphize: { maxVariants: 16, minSavings: 0.05 } // e.g. a variant-heavy
  // design system, while skipping specializations that save under 5%
  ```
- **Escape hatches (`engine` / `parser`).** If you ever hit a bug in the Rust
  path, opt out per axis: `engine: 'js'` forces the JS engine, `parser: 'svelte'`
  forces svelte/compiler (the previous default). `@rsvelte/compiler` is a bundled
  dependency, so the default parser normally just loads; in the unlikely event it
  can't (a broken install), the plugin **throws** rather than silently falling
  back — so the same source always shakes the same on every machine. Reinstall
  dependencies, or set `parser: 'svelte'`.
- **`preserve`** — keep a component's **prop interface** exactly as written, because
  something the shake can't see passes props to it. What is preserved is the props,
  **not** the file's presence in the bundle: this is unrelated to Rollup/Vite's
  `external`, and it never keeps a file out of the bundle or out of the analysis.

  You need it when the consumer lives outside the `.svelte` graph and the shaker
  can't observe the call site — a `mount()` behind a **non-literal** dynamic
  `import(expr)`, or a module outside the `entries` roots. Consumers reached by a
  static import, `export … from`, or a **literal** `import('./X.svelte')` are found
  by the plugin's own scan of your non-`.svelte` modules, so a plain
  `mount(Component, { props })` is already handled for you.

  Each entry is a root-relative or absolute path naming a component file (with its
  `.svelte` extension) or a directory of them (same path-prefix basis as `entries`).
  The file stays fully analyzed and its own call sites still count toward its
  children — only that component's own prop folding is turned off. It is not a
  scan-exclusion filter.

  **When in doubt, list it.** Unlike `entries`, over-listing errs safe: a component
  preserved without needing it is just shaken less, never wrongly.

  The build **warns** (with the file path) about any module the scan couldn't
  parse — so a mounted component isn't silently left unprotected — and about
  `preserve` entries that matched no component.

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
- **`entries` must cover the whole app** — the crawl starts there, and every
  `.svelte` file it finds is a call-site source. A call site outside those roots
  is invisible, so narrowing `entries` does not shake less, it shakes _wrongly_.
  (Components reached _from_ the roots — including library ones in `node_modules`
  — are crawled and shaken without being listed.) Call sites in `.ts`/`.js`
  modules under the roots (e.g. `mount(Component, { props })`) are scanned and the
  component's props are kept automatically; a **non-literal** dynamic `import(expr)`
  can't be followed, so reach for `preserve` there. That scan covers modules
  **under the `entries` roots only** — a library that mounts its own component
  from its own bundled `.js`/`.ts` inside `node_modules` is not scanned, so list
  it in `preserve` (with its resolved path) if you hit that.

See [`docs/ARCHITECTURE.md`](https://github.com/baseballyama/svelte-shaker/blob/main/docs/ARCHITECTURE.md)
for the full design and implementation status.

## License

MIT
