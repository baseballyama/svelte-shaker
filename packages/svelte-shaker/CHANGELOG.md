# svelte-shaker

## 0.5.0

### Minor Changes

- 5f4e22e: Add an opt-in `parser: 'rsvelte'` option for a ~1.46x faster build.

  The Vite plugin (and `svelteShaker`'s new optional `parse` argument) can now drive the engine with rsvelte's native parser instead of svelte/compiler:

  ```js
  shaker({ parser: "rsvelte" }); // default stays 'svelte'
  ```

  On a real 474-component app the full shake pipeline runs **~1.46x faster** (parse alone ~2.2x); parse dominates the pipeline (~85%), the engine's analyze+transform is only ~15%. The parser is injected once and shared between the crawl and the analysis, so each file is parsed a single time (the default svelte/compiler path actually parses twice — this is also a small win there).

  Details:

  - `'rsvelte'` requires the OPTIONAL peer `@rsvelte/vite-plugin-svelte-native` (`>=0.2.4`). It is **not** installed by default; add it yourself to opt in.
  - The native parser is always invoked with `skipExpressionLoc: true` — the per-expression `loc` blocks roughly double the AST and make the engine's walk the bottleneck (the pipeline is actually _slower_, 0.72x, with them). The engine reads only UTF-16 `start`/`end`, never `loc`, so dropping them changes nothing in the output.
  - **Soundness is parser-independent**: the engine only folds props that are never passed program-wide. Validated on a real 474-component corpus — every rsvelte-driven output compiles, and the few differences from the svelte/compiler path are all cases where rsvelte shakes _more_ (a never-passed prop folded to `undefined`, a redundant attribute removed), each behavior-preserving.
  - If `'rsvelte'` is requested but the native package can't be loaded (not installed, or no prebuilt binary for the platform), the plugin **throws** rather than silently falling back to svelte/compiler — a silent fallback would make the same source shake differently depending on whether the optional binary happens to be present, breaking build reproducibility.

  The default (`'svelte'`) path is byte-for-byte unchanged. Requires the upstream rsvelte fixes #791/#792/#793/#916 (all released).

### Patch Changes

- ccfc571: Don't fold a never-passed prop's literal into a **TS type-member key**.

  When a prop is only ever read at its default (so it folds to a literal and is dropped from `$props()`), every _value_ reference to it is substituted with that literal. The reference walk's `isNonReference` guard already excluded object-literal property keys, member-expression properties, and import/export specifiers — but **not** the key of a `TSPropertySignature` / `TSMethodSignature`. So a component whose prop is also a member of its `Props` type:

  ```ts
  interface Props {
    width?: number;
    height?: number;
  }
  const { width = 36, height = 20 }: Props = $props();
  ```

  had its type corrupted — `width?: number` became `36?: number`, `height?: number` became `20?: number` (and a string default like `label = '…'` produced a `'…'?: string` key). The type text is erased at compile, so this was byte-wrong but never a runtime fault; still, the type member must keep its name. `isNonReference` now skips a non-computed `TSPropertySignature`/`TSMethodSignature` key, so the interface member is preserved while the body's value reads still fold. The Rust/WASM engine mirrors the same guard (differential oracle green).

## 0.4.0

### Minor Changes

- b1c8780: Shake components imported through a barrel, a named specifier, or a namespace — the design-system / component-library shape.

  Until now a component reached through anything other than a direct `import Child from './Child.svelte'` (i.e. `import { Button } from '@ui'`, `import Button from '@ui/button'`, or `import * as ui from '@ui'; <ui.Button/>`) was conservatively bailed, so the shaker was effectively a no-op on the overwhelmingly common setup where an app consumes its UI from a library. Those call sites are now attributed to the child's value set — the local name (or dotted `ns.Child` member) pins the component exactly, so folding on the complete set is sound and defended by the existing differential-SSR oracle. The blanket "barrel" bail is gone; only genuinely unobservable cases (a component that escapes as a value, including a leaked namespace object) still bail.

  The Vite plugin now resolves **bare/workspace specifiers** through Vite's own resolver (`this.resolve`), so a library consumed as `@scope/ui` is crawled into the whole-program analysis instead of treated as an opaque external; an unresolvable specifier (e.g. a types-only subpath) is simply left out of scope. Barrel files written in **TypeScript** (the norm for a design-system `index.ts`: `export type { … }`, type-only specifiers, annotations) are now parsed as TS, so a library is no longer skipped just because its entry is `.ts`.

  Shaking real component libraries surfaced (and this release fixes) several transform-robustness bugs that the previous, narrower scope never hit:

  - Dropping a **run of consecutive `$props()` properties** (including a trailing comma on the last one) no longer leaves a dangling `,` in the destructuring.
  - Folding a prop used in an **object shorthand** (`{ placeholder }`) now expands to `{ placeholder: <lit> }` instead of the invalid `{ <lit> }`.
  - A folded prop on a `<Child/>` inside a **folded-away branch** no longer triggers an overlapping `MagicString` edit ("Cannot split a chunk that has already been edited").

  As a final safety net, the shaken source for each component is **re-parsed**; if a transform ever produced source that does not parse, that one file is left untouched (a sound "did not shake this component") rather than breaking the build.

  This is a sound superset of the previous behavior: anything already shaken is unchanged; barrel/named/namespace-imported components that the app uses uniformly now fold and narrow like any direct child. The Rust/WASM engine mirrors every change (differential oracle green). Verified end-to-end on real Vite 8 / rolldown apps.

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
