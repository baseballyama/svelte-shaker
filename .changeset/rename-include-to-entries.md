---
'svelte-shaker': minor
---

**BREAKING:** The Vite plugin's `include` option was renamed to `entries`.
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

