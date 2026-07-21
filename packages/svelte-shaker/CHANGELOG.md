# svelte-shaker

## 0.15.0

### Minor Changes

- 84452db: Stop counting test and Storybook files under `entries` as component consumers by
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
  devOnly: [
    "**/*.test.*",
    "**/*.spec.*",
    "**/__tests__/**",
    "**/__mocks__/**",
    "**/*.stories.*",
  ];
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

### Patch Changes

- ad03dfc: Fix the default `rsvelte` parser mangling components that contain multibyte
  characters (Japanese, emoji, accented Latin, …). Any non-ASCII character before
  an edit made the shaker splice at the wrong index: it crashed with
  `MagicString: end is out of bounds` when the offset drift was large, and — worse
  — silently corrupted the output when the drift was small.

  The bundled `@rsvelte/compiler` is updated from 0.6.1 to 0.8.1, which reports
  AST positions in UTF-16 code units (the units the engine works in) rather than
  UTF-8 bytes, and emits full TypeScript type nodes for inline `$props()`
  annotations. The `rsvelte` parser now shakes to byte-for-byte the same output as
  the `svelte` parser across the entire fixture corpus, multibyte sources
  included.

## 0.14.1

### Patch Changes

- 4b0736e: Stop dropping slotted content passed to components that consume it through a
  legacy `<slot>` or `$$slots` (both legal in Svelte 5 runes mode).

  A call site like `<Wrapper let:val><Child text={val}/></Wrapper>`, where
  `Wrapper.svelte` renders its content through a legacy `<slot>`, previously had its
  body deleted: the reverse pass models a child's reachable inputs from its
  `$props()` shape, and such a component has no `$props()` entry for the slotted
  content, so the body looked unread and was removed. That changed the rendered HTML
  (the slotted `<Child>` disappeared) — a soundness violation. The same held for a
  component that reads `$$slots` without any `<slot>` element (e.g.
  `{#if $$slots.default}…{/if}`).

  A component that observes slotted content — a `<slot>` element anywhere in its
  template, or a `$$slots` read in its script or template — now reports its
  reachable inputs as unknown, so the reverse pass leaves every call site's body
  content intact. This covers a legacy-slot component with no instance script, one
  that mixes an instance script (with `$props()`) with a legacy `<slot>`, and a
  `$$slots`-only component; named slots and `let:` bindings ride on the same
  mechanism and are equally preserved.

## 0.14.0

### Minor Changes

- 9e28445: Fold owner-local constant bindings at call sites.

  A `<Child {count}/>` that forwards an owner-local binding now shakes the child
  when that binding is provably a single primitive constant — a `const count = 0`,
  or an unmutated `let count = $state(0)`. Previously only inline call-site literals
  (`<Child count={0}/>`) drove folding; a value passed through a named binding —
  the common shape in real apps (`const VARIANT = 'primary'`, a page-level
  `$state`) — evaluated to unknown, so the child kept its dead branches, unused
  props, and unreachable CSS.

  Each component now precomputes a `scriptConstEnv` from its module and instance
  `<script>` top-level declarations (in order, so `const a = 1; const b = a + 1`
  both resolve), unwrapping `$state(<arg>)` / `$state.raw(<arg>)`. It is merged into
  the owner's fold environment wherever a forwarded call-site expression is
  evaluated, so it feeds **both** constant folding and value-set narrowing.

  Admission is conservative for soundness — a binding is used only when its
  identifier definitely denotes one constant primitive at every call site:
  primitives only (object/`$state({...})` initializers are excluded — deep mutation
  through a proxy is possible); never a written binding (reassigned / `++` /
  `bind:`); never a name a template binder or nested scope also binds (a scope-blind
  call site could mean the other entity); never `$derived` / `$props` / any other
  rune; and never an exported binding (reachable outside the analyzed graph).

  Behavior-preserving: shaking still only ever removes code the app can never reach,
  guarded by the differential-SSR oracle. Both the JS and Rust (WASM) engines
  implement it identically, keeping their output byte-for-byte equal.

- 9023ddf: `shaker()` now **throws** on an unknown option key, naming the key and listing the
  options that do exist:

  ```
  [vite-plugin-svelte-shaker] unknown option "preserv". Valid options are: entries,
  preserve, monomorphize, engine, dev, parser, verbose. Check the spelling — an
  option we do not read is an option that does not apply.
  ```

  A typo used to be ignored, which is the same failure as a stale key: the build
  succeeds with the setting not applied. For a misspelled `preserve` that means the
  component you meant to protect ships over-shaken. TypeScript only catches this on
  an object literal written inline, so a config assembled in a variable — or any JS
  config — had nothing checking it.

- b1a4d61: **BREAKING:** The Vite plugin's `external` option was renamed to `preserve`.
  Passing `external` now **throws** with a message naming the new option, so a
  stale config fails the build instead of silently shaking a component the user
  meant to protect.

  Migrate: rename the key.

  ```diff
  -shaker({ external: ['./src/lib/Widget.svelte'] })
  +shaker({ preserve: ['./src/lib/Widget.svelte'] })
  ```

  `external` is a name Rollup and Vite have already spent, and on something this
  option has never done: there it means "don't bundle this — leave it as an
  external import." This option has nothing to do with bundling. It names
  components whose **prop interface** must be left exactly as written, because a
  consumer the shaker cannot observe passes props to them: a `mount()` behind a
  non-literal dynamic `import(expr)`, or a call site in a module outside the
  `entries` roots. What it preserves is the props, **not** the file's presence in
  the bundle — listing a component never keeps it out of the bundle, and never
  even takes it out of the analysis.

  The old docs were the tell. They had to spend two separate sentences saying what
  the name is _not_ ("it does NOT exclude it from the scan", "it is not a way to
  make the shaker ignore a file"). When the documentation has to argue with the
  identifier, the identifier is wrong. `preserve` says which direction the option
  moves — leave this alone — and sits in the same vocabulary as Svelte's own
  `preserveComments` / `preserveWhitespace`.

  Semantics are unchanged. The file stays fully analyzed and its own call sites
  still count toward its children; only that component's own prop folding and
  never-passed reporting are turned off. And unlike `entries`, over-listing is the
  safe direction: a component preserved without needing it is simply shaken less,
  never wrongly.

  For the same reason, `computeEscapedComponents` (from `svelte-shaker/node`,
  which you only touch if you drive the shake from your own plugin) takes
  `preserve` where it took `external`, and returns `unmatchedPreserve` where it
  returned `unmatchedExternal`.

- ce747d1: **BREAKING:** The Vite plugin's `include` option was renamed to `entries`.
  Passing `include` now **throws** with a message naming the new option, so a
  stale config fails the build instead of silently falling back to the Vite root.

  Migrate: rename the key.

  ```diff
  -shaker({ include: ['src'] })
  +shaker({ entries: ['src'] })
  ```

  `include` is a name the ecosystem has already spent — in `@rollup/pluginutils`
  and in `vite-plugin-svelte` itself it means "the glob of files this plugin
  processes." This option has never been that. It lists the directories the
  component crawl **starts from**; everything reachable from there is shaken,
  including library components under `node_modules` that no `include` glob would
  ever have matched. So the old name described the opposite of what the option
  does.

  That mismatch pushed users the unsafe way. Reading `include` as "the files I
  want processed" invites narrowing it to a subset of the app — and narrowing the
  crawl roots doesn't shake less, it hides call sites, which is exactly how a prop
  that _is_ passed somewhere gets folded away and your build breaks. `entries`
  names the operation honestly, matching SvelteKit's `config.kit.prerender.entries`
  ("pages to prerender, or start crawling from"): list the roots, reach the rest by
  following the graph. Like `prerender.entries`, it takes paths, not globs.

  Only the name changed — same semantics, same default (the Vite root), and the
  same soundness contract: the roots must cover every call site in your app.

  For the same reason, `computeEscapedComponents` (from `svelte-shaker/node`,
  which you only touch if you drive the shake from your own plugin) takes
  `entryDirs` where it took `includeDirs`.

## 0.13.0

### Minor Changes

- 06ee2c9: Remove a trailing `{:else}` arm the reachable value set can never hit.

  When an if/else-if chain ends in `{:else}` and every test is driven by a single
  narrowed prop (`variant ∈ {'primary','secondary'}`), the shaker now enumerates
  that value set and checks each value against the arms: if every value makes some
  earlier test provably fire, the `{:else}` body is unreachable and is deleted —
  taking its call sites, imports, and any `<style>` rules that only its markup could
  produce along with it (via the existing cascade and CSS pruning). This is a
  soundness-preserving precision improvement: a value whose test cannot be settled,
  a chain driven by two or more narrowed props, or a value set larger than 64 all
  leave the `{:else}` untouched.

- c6cd1d1: Never fold a component's props when a `.ts`/`.js` module uses it, and add an
  `external` option to freeze components by hand.

  The shake only reads `.svelte`, so a call site in a plain module — `mount(Component,
{ props })`, `render(...)`, a lazy `import('./X.svelte')` — used to be invisible.
  A component used from **both** a `.svelte` template and a `.ts` module could have a
  prop folded to its default even though the module passed it, changing what you see.

  The Vite plugin now scans your non-`.svelte` modules under `include` and freezes any
  component reached by a static import, `export … from`, or a literal
  `import('./X.svelte')` — so ordinary `mount(...)` call sites are handled for you, in
  both `vite build` and incremental dev.

  For the cases the scan can't follow — a **non-literal** dynamic `import(expr)`, or a
  call site in a module outside `include` — the new `external` option freezes named
  components: `shaker({ include: ['src'], external: ['src/widgets/Chart.svelte'] })`.
  Entries are root-relative or absolute paths naming a component file or a directory
  of them. `external` freezes the component only — the file stays fully analyzed and
  its own call sites keep counting; it is not a way to exclude a file from the scan.

- ebd2801: **BREAKING:** The `level` plugin option was removed. The always-on passes
  (unused-prop fold / constant fold / value-set narrowing) have no switch;
  monomorphization is controlled solely by `monomorphize: false | { ... }`.

  `level: 0|1|2` and `monomorphize` were two paths to the same on/off, and
  `level: 0` vs `level: 1` never differed — a parallel API for one capability.
  Now there is one knob.

  Migrate:

  - `level: 0` / `level: 1` → `monomorphize: false`
  - `level: 2` → remove the option (monomorphization is on by default)

  `monomorphize` keeps its tuning object form (`{ maxVariants, minSavings }`).

- ba2fe00: **BREAKING:** The Vite plugin now parses with rsvelte by default
  (`parser: 'rsvelte'`); svelte/compiler becomes the fallback. rsvelte is loaded
  from `@rsvelte/compiler`, a bundled WASM dependency — there is **nothing extra
  to install** and no platform-specific binary.

  Soundness is parser-independent: the engine reads only UTF-16 `start`/`end`, so
  svelte/compiler and rsvelte are differentially tested to produce SSR-equivalent
  output — the default never changes what renders. Because a silent fallback would
  make the same source shake differently depending on the machine, the plugin
  **throws** when the default parser can't be loaded (an unlikely broken install)
  rather than quietly using svelte/compiler.

  Nothing to do to adopt it — a plain install ships the parser. To keep the
  previous parser instead, set `shaker({ parser: 'svelte' })`. This also applies
  if you opt into dev shaking (`dev: 'coarse' | 'incremental'`, still off by
  default): it uses the same default `parser: 'rsvelte'`.

  Unaffected: the environment-free `svelteShaker` engine API and the in-browser
  playground still parse with svelte/compiler (they don't load the Node-only WASM
  module). The `engine` default (`'auto'`: Rust/WASM when loadable, else JS) is
  unchanged.

- b568b8f: Declared-but-never-read props are now dropped, and their call-site attributes
  removed.

  When a component destructures a prop out of `$props()` but never reads it in a
  value position (instance script or template), the shaker removes the pointless
  attribute at every call site — so a heavy import passed only to an unread prop
  (`<Icon icon={Heavy}/>`) goes unreferenced and the bundler can drop it — and, when
  it is safe, drops the prop from the child's `$props()` signature entirely. This
  complements the reverse pass (which removes inputs a child never _declares_).

  It is sound-first: the attribute is removed only when its value is side-effect-free
  AND the prop's default cannot be observed (absent, a literal, or `undefined`),
  because Svelte evaluates a destructure default eagerly when the prop is omitted;
  the declaration is dropped only with no `...rest`, a harmless default, and every
  call site either spread-carrying or side-effect-free — and a parent `bind:` is
  never touched. TS type-position references do not count as reads (types are
  erased), so a prop used only in a type is still eliminated.

- 493994a: Attributes and snippet bodies a child component can never read are now removed at
  every call site.

  Reverse analysis: because a Svelte 5 (runes) component reads inputs only through
  its `$props()` destructure, an input it does not declare — and cannot capture via
  `...rest` — is invisible to it. The shaker now uses each child's reachable-input
  set to delete, at every call site, the things that supply an input the child can
  never observe: a side-effect-free attribute for an undeclared prop, a
  `{#snippet foo}` block for a snippet the child never renders, and the body content
  when the child never reads `children`. This is a whole-program deletion no
  single-file tool can make — dropping `<Icon icon={Heavy}/>` when `Icon` never
  reads `icon` can leave the owner's `import Heavy` unreferenced, so the bundler
  drops the module.

  It stays sound-first: nothing is removed when the child bailed, carries a
  `...rest`, or the call site has a spread; a `bind:` directive and any value that
  could have an evaluation side effect (a call, member access, template/logical
  expression) are always kept.

### Patch Changes

- 45185a7: Props forwarded through intermediate components now fold when the whole app passes
  a single value.

  When a component folds a prop to a constant and then forwards it to a child
  (`<Child prop={prop}/>`, `<Child prop={prop === 'a' ? 'x' : 'y'}/>`, or a pure
  literal expression like `prop={'a' + 'b'}`), the shaker now evaluates that
  call-site expression against the owner's folded value and propagates the constant
  into the child — so the child folds, drops the prop from `$props()`, and the
  now-pointless attribute is removed at the forwarding site. This is a
  soundness-preserving precision improvement: it only ever folds a value the app
  provably passes, and value-set (narrow) forwarding is intentionally left dynamic.

- 92f61ec: CSS pruning now ignores class sources inside branches the shaker removes.

  When computing which classes a component can produce, the shaker now excludes any
  class-bearing markup that sits inside a region it deletes — a folded-away `{#if}`
  arm, or a call-site input a child never reads. Previously a dynamic `class={expr}`
  or a spread hiding in a dead branch made the whole component's class set
  "unbounded" and blocked every `<style>` rule removal; now that source never
  renders, so it no longer counts and the reachable rules can still be shaken. A
  branch that collapses to a kept `{:else}` arm still counts that arm's classes, so
  no rule that can match is ever removed.

- 8a78443: CSS pruning now fires for components that only have inputs removed, not folded.

  A component that folds or narrows nothing — but whose body still has a call-site
  input a child never reads (or an unread declared prop) removed — used to skip CSS
  pruning entirely. So when the removed region was the only home of an unbounded
  class source (`class={dynamic}`, `{...rest}`), the class set stayed "unbounded"
  and no `<style>` rule could be shaken, even though that source no longer renders.
  The shaker now prunes CSS on that path too, using the removed region as the
  excluded set. This only ever removes a rule whose class the component provably
  cannot produce; a component with nothing removed is left byte-identical.

- db2717d: Pass-through folds now reach the deepest components of long forwarding chains.

  Propagating a folded constant through intermediate components advances one hop per
  analysis round, so a value forwarded down a chain longer than 10 components used
  to stop short — the deepest components stayed dynamic (still correct, just less
  optimized). The fixpoint iteration bound now scales with the component count, so
  the fold reaches the leaf of realistically deep chains and the dead branches
  behind it are removed. Shallow projects are unaffected: the analysis still stops
  as soon as the plans stabilize, which is well before the bound.

- f16fa47: Value sets now flow through pass-through call sites.

  Building on the folded-constant forwarding, a prop the app narrows to a known
  reachable set (`variant ∈ {primary, secondary}`) now propagates that whole set
  into a child it is forwarded to verbatim (`<Child variant={variant}/>`). The
  child's own value-set narrowing then fires across the component boundary — dead
  `{#if}` arms and provably-unmatchable `<style>` rules are removed in the child
  too, not just in the component that originally passed the prop. Only a bare
  forwarded prop propagates a set; a compound expression over it stays dynamic. As
  before this is soundness-preserving: it only ever contributes values the app
  provably passes.

- 679292c: fix: never fold a prop the component writes to (soundness)

  A prop that the component reassigns (`p = …`), mutates (`p++`), destructure-assigns
  (`({ p } = obj)`), or two-way binds (`bind:value={p}`) is not a constant, even when
  every call site passes the same literal — the write changes it at runtime. Such props
  are no longer const-folded, so the value seen after the write, and the call-site
  attribute that supplies the initial value, are both preserved. As an extra safety
  net, if a transform ever emits source that fails to re-parse, the shaker now reverts
  the whole affected component graph together instead of just the broken file, so a
  child and its parent can never end up in an inconsistent state.

- 5b33080: Stop the Vite plugin from triggering Rollup/Rolldown's `[SOURCEMAP_BROKEN]
Sourcemap is likely to be incorrect` warning.

  When the shaker slims a component it replaces the source in its `transform` hook,
  but until source-level mappings land it has no sourcemap to hand back. It now
  returns the `{ mappings: '' }` sentinel for those files — the value Rollup's
  `SourceMapInput` type carries to mean "no map declared", which its runtime skips
  instead of flagging as a missing map — so the misleading warning no longer appears
  during `vite build`.

## 0.12.0

### Minor Changes

- 7da1d9d: Add `svelte-shaker-engine-scan-native`, an optional native (napi) prop scanner.

  It parses every component with rsvelte natively (in parallel) and walks rsvelte's
  **typed AST directly** — the full-AST `serde_json::Value` is never built — to compute
  the whole-program never-passed-props scan that backs ESLint's `svelte/no-useless-props`.
  On the flygate corpus (650 components) this runs in ~57 ms vs ~680 ms for the JS path
  (~12×), with byte-identical results.

  Soundness is pinned two ways: `tests/native-never-passed.test.ts` pins the typed scan
  to the JS `findNeverPassedProps` (name + span, incl. non-ASCII UTF-16, rename,
  namespace/barrel, spread, body), and a `scan` (typed) vs `scan_via_value` (the
  reused, already-validated Value engine) vs JS corpus check confirms byte-for-byte
  agreement across all 650 files. The ESLint rule prefers the addon when installed and
  falls back to the JS/WASM engine otherwise.

  Ships a `ScanDaemon` for editors/LSP: cache each file's model once, then `update`
  re-parses only the changed files and re-runs the cheap whole-program assembly — a
  single-file edit re-scans in ~1.3 ms (vs ~41 ms cold), byte-identical to a cold scan.

  Also parallelizes the per-file model build in the Value engine's
  `find_never_passed_props` (rayon, native-only — wasm stays sequential and unchanged).

## 0.11.0

### Minor Changes

- e014c5e: Add a Rust/WASM `find_never_passed_props` (engine) and its `find_never_passed_props_json`
  WASM export — the native counterpart of the TS `findNeverPassedProps`, pinned
  byte-for-byte to it by a differential test. This is the foundation for a fully
  native (napi) prop scan: the analysis now runs in Rust, so a native caller can
  parse with the rsvelte parser and analyze without crossing an AST/JSON boundary.

## 0.10.2

### Patch Changes

- ec13b78: Resolve barrels lazily during the crawl. A `.js`/`.ts` re-export ("barrel") was
  read and parsed for **every** named import to chase the export, even for
  value-only imports (helpers, types) that are never rendered as a component. Now a
  barrel is followed only for a named import actually rendered as `<Local>` here —
  a value-only import can never be a call site, so skipping it leaves attribution
  (and every model) unchanged. On a ~650-component app this cut the whole-program
  crawl roughly 3-4x (most of the time was parsing modules behind value-only
  imports), with byte-identical analysis output.

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
