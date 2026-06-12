<script lang="ts">
  import Box from './Box.svelte';
</script>

<!-- `hidden` is proven false at the only call site, so the dead `{#if}` chain is
     removed.  It separated the `<div>` edge from `<p>`, so a `{" "}` must replace
     the chain or the rendered space between them is lost. -->
<Box />
