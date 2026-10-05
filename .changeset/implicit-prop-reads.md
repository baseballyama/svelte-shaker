---
'svelte-shaker': patch
---

Stop removing a prop that is read without a plain identifier. The shaker treated
these props as unread and dropped them from `$props()`, which broke the build or
the page:

- a store auto-subscription (`let { progressStore } = $props()` with
  `{$progressStore.current}` in the markup or `$progressStore` in the script) failed
  to compile with `global_reference_invalid`;
- a `style:width` shorthand directive threw `width is not defined` when the caller
  passed a value only known at runtime;
- a component tag from a prop (`<Icon />`, `<component.Root />`) threw
  `component is not defined`;
- an action, transition or animation from a prop (`use:action`, `transition:fn`,
  `in:fn`, `out:fn`, `animate:fn`) threw `… is not defined` in the browser.

A constant prop is still folded where that is safe. `style:width` with a literal
`width` still becomes `style:width={"42px"}`. A prop that is never passed and only
used inside `{#if Icon}<Icon />{/if}` still has the dead branch removed. Both the
JavaScript and the native engine have the fix.
