---
'svelte-shaker': minor
---

**BREAKING:** The Vite plugin now parses with rsvelte by default
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
