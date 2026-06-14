<p align="center">
  <img src="./assets/logo.png" alt="svelte-shaker" width="190" />
</p>

<h1 align="center">svelte-shaker</h1>

<p align="center">
  <strong>Remove the dead Svelte&nbsp;5 (runes) code your bundler can't</strong> — dead
  branches, the child components they pull in, and unreachable CSS — by
  partial-evaluating each component against how your <em>whole app</em> actually
  uses it, before the compiler. Sound: it never changes what renders.
</p>

**▶ Try it in the browser: https://baseballyama.github.io/svelte-shaker/** — an
interactive playground that runs the engine entirely client-side (and is itself
built with rsvelte + dogfooded through svelte-shaker).

It runs in your app's production build, _before_ the Svelte compiler, and slims
each `.svelte` file by partially evaluating it against how the **whole app**
actually uses it: props that are never passed (or always passed the same value)
are folded to their constant, the dead `{#if}` arms behind them are deleted,
those props are dropped from the `$props()` signature, and the now-pointless
attributes are removed at every call site. The Svelte compiler then only sees the
code your app can actually reach.

It is **sound first**: it never changes what the user sees. When it cannot prove
a transform is safe, it leaves the code untouched (bails).

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full design.

## Why this exists (and why a JS bundler can't do it)

Design-system components carry lots of props (`Button` with
`variant / size / loading / icon / iconPosition / fullWidth / rounded / href …`),
but any one app uses only a few. The code behind the unused props — template
branches, class computation, reactive statements, imports, CSS — is effectively
dead for that app, yet it ships anyway.

It cannot be removed _after_ Svelte compiles, because Svelte emits **one generic
JS module per component**, shared by every caller. In that JS the prop values
flow through the runtime (`$.prop(...)`), so `loading` / `variant` are not static
JS constants — terser/esbuild/Rollup cannot fold `if (loading)` to `if (false)`,
and the single module has no whole-program information to know which props this
particular app never uses.

svelte-shaker works **one step earlier**, on the pre-compile Svelte source, where
the prop's value (its default, or the literal at the call site) is still visible
and the template structure is intact. It is essentially a **whole-program partial
evaluator + dead-code eliminator that understands Svelte**, driven by every call
site in the app.

### The CSS differentiator (what a bundler genuinely can't reach)

Given `class="btn btn-{variant}"` where the app only ever passes
`variant ∈ {primary, secondary}`, the class `btn-danger` can never exist at
runtime. But the class only appears as a runtime string, so:

- Svelte's own unused-CSS pruning keeps `.btn-danger` (it can't see inside the
  interpolation), and
- Rollup/terser can't touch it either (the class isn't in the JS at all).

svelte-shaker computes the reachable value set of `variant`, proves the
`.btn-danger` / `.btn-ghost` rules can never match any element this component
renders, and **removes those `<style>` rules** — while keeping `.btn`,
`.btn-primary`, `.btn-secondary`. This is verified end-to-end in
`packages/svelte-shaker/tests/css.test.ts`.

## Install

```sh
pnpm add -D svelte-shaker
# or: npm i -D svelte-shaker / yarn add -D svelte-shaker
```

Requires `svelte@^5`.

## Usage (Vite)

Add the plugin **before** `svelte()` so it hands already-slimmed source to the
Svelte compiler. It is **build-only by design** — dev is a pass-through (see
[Soundness](#soundness) / [Limitations](#limitations)).

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

There is also a plain-Rollup plugin (`rollup-plugin-svelte-shaker`) for non-Vite
pipelines; the Vite plugin is preferred for apps.

### Options

```ts
shaker({
  include: ['src'], // dirs (relative to root) holding every .svelte call site
  level: 1, //  0 | 1 | 2 — default 1 (L0/L1/L1.5 always on). 2 = opt-in L2.
  monomorphize: false, // L2 tuning; only consulted when level: 2.
  parser: 'svelte', // 'svelte' (default) | 'rsvelte' — see below.
});

// Opt into L2 per-call-site monomorphization:
shaker({ include: ['src'], level: 2, monomorphize: true });
shaker({ include: ['src'], level: 2, monomorphize: { maxVariants: 16 } });

// Opt into the faster rsvelte parser (~1.46x full build, ~2.2x parse).
// Requires the optional peer `@rsvelte/vite-plugin-svelte-native` (install it
// yourself). Soundness is unchanged — it only affects speed and, occasionally,
// shakes a little more. If the native package can't load it THROWS (no silent
// fallback) so the output stays the same on every machine.
shaker({ include: ['src'], parser: 'rsvelte' });
```

### The rsvelte (Rust) parser

By default the engine parses with `svelte/compiler`. Setting `parser: 'rsvelte'`
swaps in [rsvelte](https://github.com/rsvelte/rsvelte)'s native (Rust) parser,
which dominates the shake pipeline (~85% of the time is parsing): on a real
474-component app the full build runs **~1.46x faster** (parse alone ~2.2x).

```sh
# rsvelte's native parser is an OPTIONAL peer — install it to opt in:
pnpm add -D @rsvelte/vite-plugin-svelte-native
```

```ts
// vite.config.ts
shaker({ include: ['src'], parser: 'rsvelte' });
```

- **Soundness is parser-independent.** The engine reads only UTF-16
  `start`/`end` offsets, so the chosen parser never changes _what_ is folded —
  only how fast. The few differences from the `svelte/compiler` path are cases
  where rsvelte happens to shake a little _more_, each still behavior-preserving.
- **No silent fallback.** If `parser: 'rsvelte'` is requested but the native
  package can't be loaded (not installed, or no prebuilt binary for the
  platform), the plugin **throws** rather than quietly using `svelte/compiler` —
  a silent fallback would make the same source shake differently depending on
  whether the optional binary is present, breaking build reproducibility.

See [`docs/RUST-MIGRATION.md`](./docs/RUST-MIGRATION.md) for the design.

## What it does

| Level    | What it removes                                                                                                                              | Default    |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **L0**   | Props no call site ever passes → fold to the default, drop from `$props()`, strip the attribute at call sites                                | on         |
| **L1**   | Props that collapse to one constant app-wide → fold + drop + strip every call site's attribute                                               | on         |
| **L1.5** | Value-set **narrowing**: with `variant ∈ {primary, secondary}`, delete provably-dead `{#if}`/`{:else if}` arms (prop stays in the signature) | on         |
| **CSS**  | `<style>` rules whose class can never be produced given the value sets — the bundler-can't differentiator                                    | on         |
| **L2**   | Per-call-site monomorphization: specialize a component per prop shape (deduped by residual, capped by `maxVariants`)                         | **opt-in** |

Folding also reaches template ternaries (`{cond ? a : b}`) and class-string
interpolation when the condition/parts are provable constants.

## Soundness

The whole point is to **never change observable behavior**.

- **Differential-SSR verified.** Tests server-render the original and the shaken
  component (comments stripped, whitespace normalized) and assert the HTML is
  identical for every value the app actually passes
  (`packages/svelte-shaker/tests/diff.ts`).
- **Conservative bail.** When a transform can't be _proven_ safe, the code is
  left as-is. Whole-component bails: `<svelte:options accessors />` /
  `customElement`, and any component that **escapes** as a value
  (`<svelte:component this={X}>`, assigned/passed/stored), or is rendered through
  a barrel/named import (its call sites aren't enumerable). Per-prop bails:
  spread that could overwrite it, callee `...rest`, `bind:`, a name shadowed by
  `{#each as}` / snippet params / `{#await then}` / `let:` / `{@const}`, or used
  in `{@debug}`.
- **Side effects preserved.** A call-site attribute is only stripped if its value
  has no side effects; a value's code is removed only when it is provably pure
  and unused.
- **Whole-program fixpoint.** Call sites inside a folded-away `{#if}` don't count
  toward a child's prop profile; analysis iterates to a fixpoint so cascades are
  consistent with what the transform actually deletes.

## Limitations

- **Svelte 5 runes only** (`$props()` / `$derived` / `$effect`). Svelte 4
  (`export let` / `$:` / `$$props`) is out of scope.
- **Needs `.svelte` source.** Libraries shipping compiled JS can't be shaken (the
  source has to be visible — that's the whole premise). Distribute via
  `svelte-package`. Anything it can't resolve is silently passed through.
- **Build only.** It runs in `vite build`, not in dev/HMR — whole-program
  analysis is fundamentally incompatible with HMR's locality, and L1.5/CSS depend
  on negative information ("this value never occurs") that a lazily-loaded dev
  server can't guarantee. Dev is always a pass-through (and is unoptimized but
  always correct). A `dev: 'coarse'` mode is a future opt-in.
- **`include` must cover the whole app.** A call site outside the scanned dirs is
  invisible, so soundness requires every consumer of a prop to be in scope.
- **Partial-bail boundaries.** Spread/rest/`bind:`/shadowing limit how much can be
  folded (by design — the engine errs toward keeping code). L2's `minSavings`,
  and `exclude` / `unsafe` / `report` options, are reserved but not yet
  implemented.

## Running the tests

```sh
pnpm --filter svelte-shaker test     # vitest: eval / basic / shadow / probes2 / css / vite / mono
pnpm format:fix && pnpm all:check    # type-check + lint + format
```

### Bench

`packages/svelte-shaker/tests/css.test.ts` builds a tiny app
(`App` passes `variant="primary"` and `variant="secondary"` to `Btn`, whose
`<style>` defines `.btn-{primary,secondary,danger,ghost}`) two ways:

- **control** (Svelte + Rollup, no shaker): keeps `.btn-danger` and `.btn-ghost`
  in the emitted CSS — the toolchain cannot prove them dead.
- **shaken**: removes `.btn-danger` / `.btn-ghost`, keeps `.btn` /
  `.btn-primary` / `.btn-secondary`, and the rendered HTML is identical for both
  variants the app passes.

That's the headline result: the same source produces strictly smaller CSS with no
behavior change.

## Architecture & status

The engine is split into an environment-free **Engine** (Svelte-aware analysis +
transform) behind a stable IR, and a thin **Shell** (the Vite/Rollup plugin) that
owns file IO and module resolution — so the core can later be ported to Rust
(rsvelte / OXC). The current implementation status (what's done vs. remaining) is
tracked in [`docs/ARCHITECTURE.md` §11](./docs/ARCHITECTURE.md#11-実装状況implementation-status).

## License

MIT
