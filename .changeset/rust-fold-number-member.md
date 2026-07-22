---
'svelte-shaker': patch
---

Fix the Rust/WASM engine emitting invalid output for a folded numeric prop used as a member-access object. `count.toLocaleString()`, with `count` folded to `5000`, produced `5000.toLocaleString()` — a syntax error (the parser reads `5000.` as a float, then hits the method name) — so the revert cascade bailed the component and left it un-shaken. The Rust engine now parenthesizes the number (`(5000).toLocaleString()`), matching the TS engine (the fix #154 made to TS had not been ported to Rust). Since the default engine for small apps (≤300 components) is Rust/WASM, this restores the shake for those components. The `wasm-shake` differential test now sweeps every golden fixture so this class of gap can't recur.
