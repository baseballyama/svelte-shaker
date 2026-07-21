---
'svelte-shaker': patch
---

Fix the default `rsvelte` parser mangling components that contain multibyte
characters (Japanese, emoji, accented Latin, …). Any non-ASCII character before
an edit made the shaker splice at the wrong index: it crashed with
`MagicString: end is out of bounds` when the offset drift was large, and — worse
— silently corrupted the output when the drift was small.

The bundled `@rsvelte/compiler` is updated from 0.6.1 to 0.8.1, which reports
AST positions in UTF-16 code units (the units the engine works in) rather than
UTF-8 bytes, and emits full TypeScript type nodes for inline `$props()`
annotations. The `rsvelte` parser now shakes to byte-for-byte the same output as
the `svelte` parser across the entire fixture corpus, multibyte sources
included.
