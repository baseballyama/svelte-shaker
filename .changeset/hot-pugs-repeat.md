---
'svelte-shaker': patch
---

Stop removing call-site attributes that are not props

- A CSS custom property on a component (`<Card --accent="red" />`) is no longer
  removed. Svelte compiles it to `$.css_props(...)`, which renders a
  `<svelte-css-wrapper>` element, so dropping it changed the rendered HTML.
- An attribute in a namespace Svelte does not define (`<Card my:directive />`)
  is no longer removed. Svelte's parser turns only its own directive prefixes
  (`bind:`, `use:`, `on:`, …) into directives and leaves any other `ns:name` as a
  plain attribute, which the shaker treated as a prop the child never reads —
  silently breaking preprocessors that consume such markers. The component is
  still shaken normally, so you no longer need to list it in `external` (which
  also froze its prop folding) to keep the marker.
- `let { 'my:directive': marker, y = 1 } = $props()` no longer loses its entire
  declaration when every identifier-keyed prop folds away. The string-literal key
  was invisible to the prop model, so `marker` silently became an undefined
  global in code that still compiled.
