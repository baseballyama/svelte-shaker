---
'svelte-shaker': minor
---

The native Rust (WASM) engine now implements **L2 monomorphization** too, so it is no longer limited to L0/L1/L1.5. The L2 graph, the never-bloat net-win gate, and the call-site rewrite all run in Rust; the only thing that crosses back to JS is the per-module compiled-size proxy the gate needs (the Svelte compiler), passed as a callback. Because both engines size modules with the same compiler, the Rust output — wired owner files **and** the generated variant modules — is byte-identical to the JS engine, pinned by a new differential test.

As a result `engine: 'auto'` (the default) and `engine: 'rust'` now run the **whole** shake, including L2, natively — you no longer have to choose between the Rust engine's speed and L2's compression. `engine: 'rust'` no longer skips L2.
