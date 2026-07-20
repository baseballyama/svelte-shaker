---
'svelte-shaker': minor
---

Fold owner-local constant bindings at call sites.

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
