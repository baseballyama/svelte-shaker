---
'svelte-shaker': minor
---

**BREAKING:** The Vite plugin's `external` option was renamed to `preserve`.
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
