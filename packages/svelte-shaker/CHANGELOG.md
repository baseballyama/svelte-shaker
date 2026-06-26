# svelte-shaker

## 0.10.1

### Patch Changes

- 6ef0bcf: Add a `default` export condition so the package can be loaded via `require()` on
  Node ≥22.12 (synchronous `require(ESM)`). Previously the exports map only
  declared `import`, so a synchronous CommonJS consumer — notably an ESLint rule
  calling `require('svelte-shaker')` — hit `ERR_PACKAGE_PATH_NOT_EXPORTED`. ESM
  consumers are unaffected (they still resolve via `import`).

## 0.10.0

### Minor Changes

- bdcd2ce: Add `findNeverPassedProps(input)` and a synchronous `buildAnalyzeInputSync` for
  lint-style dead-code reporting.

  `findNeverPassedProps` returns, per component, the declared props that NO call
  site in the analyzed program ever passes (explicitly, via `bind:`, via a spread,
  or as body/`{#snippet}` content) — props the component declares but no consumer
  supplies. It only reports high-confidence cases, mirroring the folder's caution:
  bailed/escaped components and components with zero call sites (entries, SvelteKit
  route pages whose props are framework-injected) are skipped, and an incomplete
  crawl can only under-report (never false-positive). Each result carries the
  prop's source span for direct mapping by a consumer such as an ESLint rule.

  `buildAnalyzeInputSync` is a synchronous twin of `buildAnalyzeInput` (sync
  `resolve`/`readFile`) for callers that cannot await — e.g. an ESLint rule, which
  runs synchronously. A differential test pins it byte-identical to the async
  crawl. `deadSpansForPlans` is now exported too.

## 0.9.2

### Patch Changes

- 466b322: Stop the escape analysis from descending into TS type-only subtrees, so a
  component named in a _type_ position is no longer falsely bailed. A reference
  like `ComponentProps<typeof Button>['pattern']` (or a `: Props` annotation) names
  `Button` only at the type level — erased at compile, never a runtime value read —
  but the escape walk treated that identifier as a value use and bailed the whole
  component, leaving it (and every component referenced the same way) un-shaken
  under the default `svelte` parser.

  The walk now skips `TSType*` nodes and `interface` declarations in both the JS
  and native Rust engines (output stays byte-identical). Real value escapes
  (`const C = Button`, `<svelte:component this={Button}>`, `Button as T`) are
  unaffected. This closes the gap where `parser: 'rsvelte'` shook a superset: on a
  large real app the default parser now matches it exactly (same files shaken, same
  bytes saved).

## 0.9.1

### Patch Changes

- 3fb1e30: Fix a build failure when a folded `{#if}` chain sits directly inside a text-free
  parent (`<table>`/`<thead>`/`<tbody>`/`<tfoot>`/`<tr>`/`<colgroup>`). The seam
  compensation used to overwrite the removed chain with a `{" "}` expression tag to
  preserve a separating space, but inside those elements Svelte's
  `is_tag_valid_with_parent('#text', …)` rejects a text child outright
  (`<#text> cannot be a child of <tr>`), and the whitespace rendered nothing there
  to begin with. The transform now threads the nearest content-model parent element
  (mirroring svelte's `parent_element` reset rules) and falls back to plain deletion
  in those parents, so a shaken component always compiles. Applied in both the JS
  and native Rust engines (output stays byte-identical, pinned by a new regression
  test).

## 0.9.0

### Minor Changes

- a650825: The native Rust (WASM) engine now implements **L2 monomorphization** too, so it is no longer limited to L0/L1/L1.5. The L2 graph, the never-bloat net-win gate, and the call-site rewrite all run in Rust; the only thing that crosses back to JS is the per-module compiled-size proxy the gate needs (the Svelte compiler), passed as a callback. Because both engines size modules with the same compiler, the Rust output — wired owner files **and** the generated variant modules — is byte-identical to the JS engine, pinned by a new differential test.

  As a result `engine: 'auto'` (the default) and `engine: 'rust'` now run the **whole** shake, including L2, natively — you no longer have to choose between the Rust engine's speed and L2's compression. `engine: 'rust'` no longer skips L2.

## 0.8.0

### Minor Changes

- b98d957: L2 per-call-site monomorphization is now **on by default**. It is bail-safe and never bloats (the measured net-win gate only specializes when it strictly shrinks the bundle), so leaving it on gives the most compression out of the box. To turn it off — e.g. to trade a little compression for faster builds — set `level: 1` (or `monomorphize: false`). Explicit `level: 2` / `monomorphize` configs are unaffected.
- b98d957: Add an `engine` option (`'auto' | 'js' | 'rust'`, default `'auto'`) to run the L0/L1/L1.5 analysis + transform in the native Rust (WASM) engine. The Rust engine is differentially tested to produce byte-identical output to the JS engine, so the choice only affects build speed, never what is shaken. `'auto'` uses the Rust engine on the L2-off path and falls back to JS otherwise; `'rust'` forces it (L2 is JS-only and is skipped); `'js'` forces the JS engine. The WASM artifact now ships inside the package.

### Patch Changes

- b98d957: Make the L2 net-win gate much cheaper: it now compiles only the modules whose size actually differs between the base and specialized scenarios (the variants plus any orphaned modules) instead of the whole reachable program for every candidate. Components reachable in both scenarios cancel out, so a child that orphans nothing is decided by sizing just its variants against its base. This makes a larger `maxVariants` affordable without changing any specialization decision.

## 0.7.0

### Minor Changes

- bbc6823: Expand statically-known object-literal spreads at call sites (`<Comp {...{ a: 1, b: 2 }} />`). Such a spread's full key set is visible, so its keys are now folded exactly as if written as attributes (`a={1} b={2}`), instead of being treated as an opaque spread that poisons every prop it might set. Opaque spreads (`{...someVar}`, or object literals carrying a nested spread / computed key / accessor) are unchanged — they still bail conservatively.
- bbc6823: The `verbose` size report now also prints the compiled-output (client JS + scoped CSS) byte savings for the shaken files, not just the pre-compile source-byte delta. A folded dead branch or a removed `<style>` rule shrinks the shipped output far more than its few source bytes suggest, so this is a truer picture of what the shake saves. Reporting only — it never affects the build output.

## 0.6.0

### Minor Changes

- 3851840: ESM-only distribution and a new `verbose` option.

  - **ESM only (breaking).** The package no longer ships a CommonJS build — the
    `require: './dist/index.cjs'` export is gone. `svelte-shaker` is now
    `import`-only. The distribution is also no longer bundled or minified: it is
    now a plain `tsc` transpile, one `dist/*.js` per source module, so stepping
    through `node_modules/svelte-shaker` reads the same file layout as the source
    and stack traces map straight back to readable code.
  - **`verbose` option.** A one-line whole-program size summary is now always
    printed after the build crawl (e.g. `shaken 9/18 files: 16.79 kB → 15.60 kB
(saved 1.19 kB, 7.1%)`). Set `verbose: true` to also get a per-file breakdown
    of every component that shrank. Reporting only — it never affects output.

## 0.5.2

### Patch Changes

- 17afa10: Document the opt-in `parser: 'rsvelte'` (Rust) parser in the package README — how to install the optional `@rsvelte/vite-plugin-svelte-native` peer, opt in, and why there is no silent fallback.

## 0.5.1

### Patch Changes

- 19efe6f: fix: aliased `$props()` destructuring (`prop: alias = default`) no longer breaks builds — references to the alias were left dangling and a same-named import could be corrupted (#37). Folds now substitute the local binding name and leave colliding imports untouched. Props bound to a nested pattern (`prop: { x }`) are now left alone instead of being folded.
- 19efe6f: fix: removing a dead `{#if}` chain (or collapsing it to its kept arm) no longer changes the rendered whitespace. A space could be lost where the chain separated two nodes (the surviving whitespace fell to a fragment edge and was trimmed), or gained from the kept arm's own edge whitespace. The chain's seam is now compensated with `{" "}` only when a space would otherwise be lost, the kept arm's leading/trailing whitespace is stripped when spliced, and whitespace inside `<pre>`/`<textarea>` (or under `preserveWhitespace`) is left byte-exact.

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
