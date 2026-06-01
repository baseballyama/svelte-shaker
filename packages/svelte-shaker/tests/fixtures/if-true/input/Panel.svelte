<script lang="ts">
  let { show, pad }: { show: boolean; pad: boolean } = $props();
</script>

{#if show}
  <p>always shown</p>
{:else}
  <p>never shown</p>
{/if}

{#if pad}{/if}

<p>panel base</p>
