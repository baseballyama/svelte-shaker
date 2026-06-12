// Pattern 13: barrel re-export.
// App.svelte imports all local pattern components through this index so the
// shaker must follow barrel re-exports when building the whole-program graph.
export { default as ShorthandFold } from './ShorthandFold.svelte';
export { default as AliasedProp } from './AliasedProp.svelte';
export { default as NestedDestructure } from './NestedDestructure.svelte';
export { default as RestProps } from './RestProps.svelte';
export { default as MultiCallSites } from './MultiCallSites.svelte';
export { default as TernaryFold } from './TernaryFold.svelte';
export { default as StyleStrip } from './StyleStrip.svelte';
export { default as Snippets } from './Snippets.svelte';
export { default as Bindable } from './Bindable.svelte';
export { default as DynamicComponent } from './DynamicComponent.svelte';
export { default as TypedProps } from './TypedProps.svelte';
