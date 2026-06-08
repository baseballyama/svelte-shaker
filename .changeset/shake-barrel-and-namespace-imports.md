---
'svelte-shaker': minor
---

Shake components imported through a barrel, a named specifier, or a namespace — the design-system / component-library shape.

Until now a component reached through anything other than a direct `import Child from './Child.svelte'` (i.e. `import { Button } from '@ui'`, `import Button from '@ui/button'`, or `import * as ui from '@ui'; <ui.Button/>`) was conservatively bailed, so the shaker was effectively a no-op on the overwhelmingly common setup where an app consumes its UI from a library. Those call sites are now attributed to the child's value set — the local name (or dotted `ns.Child` member) pins the component exactly, so folding on the complete set is sound and defended by the existing differential-SSR oracle. The blanket "barrel" bail is gone; only genuinely unobservable cases (a component that escapes as a value, including a leaked namespace object) still bail.

The Vite plugin now resolves **bare/workspace specifiers** through Vite's own resolver (`this.resolve`), so a library consumed as `@scope/ui` is crawled into the whole-program analysis instead of treated as an opaque external; an unresolvable specifier (e.g. a types-only subpath) is simply left out of scope. Barrel files written in **TypeScript** (the norm for a design-system `index.ts`: `export type { … }`, type-only specifiers, annotations) are now parsed as TS, so a library is no longer skipped just because its entry is `.ts`.

Shaking real component libraries surfaced (and this release fixes) several transform-robustness bugs that the previous, narrower scope never hit:

- Dropping a **run of consecutive `$props()` properties** (including a trailing comma on the last one) no longer leaves a dangling `,` in the destructuring.
- Folding a prop used in an **object shorthand** (`{ placeholder }`) now expands to `{ placeholder: <lit> }` instead of the invalid `{ <lit> }`.
- A folded prop on a `<Child/>` inside a **folded-away branch** no longer triggers an overlapping `MagicString` edit ("Cannot split a chunk that has already been edited").

As a final safety net, the shaken source for each component is **re-parsed**; if a transform ever produced source that does not parse, that one file is left untouched (a sound "did not shake this component") rather than breaking the build.

This is a sound superset of the previous behavior: anything already shaken is unchanged; barrel/named/namespace-imported components that the app uses uniformly now fold and narrow like any direct child. The Rust/WASM engine mirrors every change (differential oracle green). Verified end-to-end on real Vite 8 / rolldown apps.
