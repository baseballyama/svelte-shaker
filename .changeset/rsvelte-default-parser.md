---
'svelte-shaker': minor
---

**BREAKING:** The Vite plugin now parses with rsvelte's native parser by
default (`parser: 'rsvelte'`), and `@rsvelte/vite-plugin-svelte-native` is now a
**required** peer dependency (previously optional). svelte/compiler becomes the
fallback for when you hit an rsvelte parser bug.

rsvelte's parser is ~1.46x faster on a real 474-component app (parse alone
~2.2x) and shakes a sound superset — soundness is parser-independent, so the
fast path never changes what renders. Because a silent fallback would make the
same source shake differently depending on whether the native binary happens to
be installed, the plugin **throws** when the default parser can't be loaded
rather than quietly using svelte/compiler.

Migrate — do one of:

- Install the peer on every platform your build runs on:
  `npm i -D @rsvelte/vite-plugin-svelte-native`
- Or keep the previous parser: `shaker({ parser: 'svelte' })`.

This also applies if you opt into dev shaking (`dev: 'coarse' | 'incremental'`,
still off by default): it uses the same default `parser: 'rsvelte'`, so
enabling dev shaking requires the peer too, unless you set `parser: 'svelte'`.

Unaffected: the environment-free `svelteShaker` engine API and the in-browser
playground still parse with svelte/compiler (they can't require a native
binary). The `engine` default (`'auto'`: Rust/WASM when loadable, else JS) is
unchanged.
