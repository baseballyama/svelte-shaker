---
'svelte-shaker': patch
---

Fix the default `rsvelte` parser mangling components that contain multibyte
characters (Japanese, emoji, accented Latin, …).

rsvelte reports AST positions as UTF-8 byte offsets, but the engine's transform
drives `magic-string` with UTF-16 code-unit offsets. Any non-ASCII character
before an edit made the two disagree, so the shaker spliced at the wrong index:
it crashed with `MagicString: end is out of bounds` when the drift was large, and
— worse — silently corrupted the output when the drift was small enough to still
land inside the string.

The `rsvelte` parser now remaps every offset from UTF-8 bytes to UTF-16 code
units before the AST reaches the engine, so multibyte sources shake to exactly the
same output as the `svelte` parser. Pure-ASCII sources are unaffected (the two
encodings coincide, so the remap is skipped).
