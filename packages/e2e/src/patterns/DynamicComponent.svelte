<script lang="ts">
  // Pattern 11: dynamic component — engine must bail, output must still work.
  // The component type is computed at runtime from an array index, so the
  // shaker cannot statically resolve `Cmp` and must leave this file untouched.
  import type { Component } from 'svelte';
  import ShorthandFold from './ShorthandFold.svelte';
  import TernaryFold from './TernaryFold.svelte';

  let { index = 0 }: { index?: number } = $props();
  // Typed by what the call site below passes; both components accept it
  // (component props are contravariant), so no cast is needed.
  const components: Component<{ isActive: boolean }>[] = [ShorthandFold, TernaryFold];
  const Cmp = components[index];
</script>

<!-- `svelte:component` with a runtime-computed reference forces the engine
     to bail.  Bailout is always sound: the output is the original source. -->
<svelte:component this={Cmp} isActive={false} />
