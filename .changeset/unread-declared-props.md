---
'svelte-shaker': minor
---

Declared-but-never-read props are now dropped, and their call-site attributes
removed.

When a component destructures a prop out of `$props()` but never reads it in a
value position (instance script or template), the shaker removes the pointless
attribute at every call site — so a heavy import passed only to an unread prop
(`<Icon icon={Heavy}/>`) goes unreferenced and the bundler can drop it — and, when
it is safe, drops the prop from the child's `$props()` signature entirely. This
complements the reverse pass (which removes inputs a child never *declares*).

It is sound-first: the attribute is removed only when its value is side-effect-free
AND the prop's default cannot be observed (absent, a literal, or `undefined`),
because Svelte evaluates a destructure default eagerly when the prop is omitted;
the declaration is dropped only with no `...rest`, a harmless default, and every
call site either spread-carrying or side-effect-free — and a parent `bind:` is
never touched. TS type-position references do not count as reads (types are
erased), so a prop used only in a type is still eliminated.
