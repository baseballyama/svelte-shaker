---
'svelte-shaker': minor
---

The monomorphization size proxy is now computed with rsvelte, so the native engine runs the whole gate in-process — no JS-compiler callback.

The net-win gate that decides which components to specialize needs a per-module "how big is the compiled output" measure. It used to call the JS `svelte/compiler` for that on every engine, including the native (napi) engine, which meant the native path — otherwise fully in-process Rust — still called back into JavaScript per candidate. Now the proxy is rsvelte's client codegen: the native engine computes it in Rust (`@rsvelte/compiler`'s `compile_client`, in-process), and the TS / WASM engines compute the identical value via the bundled `@rsvelte/compiler`. The three engines still decide byte-for-byte alike (pinned by the differential parity tests), and when the native engine is active the hot path no longer touches a JS compiler for sizing.

This changes which specializations the gate chooses versus before (rsvelte's compiled sizes replace svelte/compiler's), but only ever which components are specialized — never what the app renders. Soundness and the "monomorphization never bloats the bundle" guarantee are unchanged.
