---
'svelte-shaker': patch
---

Fix the Rust (WASM/native) engine folding a number to a form JS never prints, which could make a shaken component render differently than the original. The engine stringified folded numbers with Rust's default formatter, which diverges from JavaScript's `Number.prototype.toString` at the exponent cutoffs — `1e21` became `1000000000000000000000` (JS: `1e+21`) and `1e-7` became `0.0000001` (JS: `1e-7`). Since that text feeds both the substituted source and the value used to compute which `<style>` rules can match, a folded numeric prop could shift the output. Number stringification now follows the ECMAScript algorithm, matching the JS engine and the browser. The engine also now reads `0b…`/`0o…` binary/octal string literals and hex literals beyond 2^63 the way JS coerces them, instead of treating them as `NaN`.

The bundled WASM engine carries this fix immediately; the optional `svelte-shaker-engine-scan-native` binary picks it up on its next release.
