---
'svelte-shaker': patch
---

Fix the non-`.svelte` module scan (and TypeScript barrel-following) failing on
valid modules whose text mentions `</script>`. The scan parses a `.ts`/`.js`
module by wrapping it in a `<script module lang="ts">` block, and any `</script>`
in the module's text — inside a comment, string, regex or template literal, as an
HTML sanitizer or a markdown pipeline routinely has — closed the wrapper early, so
a perfectly valid file failed to parse, landed in `unscannable`, and triggered the
"use `preserve`" warning (while silently losing shake coverage for components
mounted from it). The closing tag is now neutralized before wrapping. In valid
JS/TS `</script` only appears inside a comment or a string/regex/template literal,
so this touches only inert text — the one exception, a module specifier that
itself contains `</script`, is detected after parsing and makes the module report
as `unscannable` (the same loud degrade as before), rather than silently resolving
a rewritten path.
