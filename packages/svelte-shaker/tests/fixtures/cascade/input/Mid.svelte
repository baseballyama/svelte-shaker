<script lang="ts">
  import Heavy from './Heavy.svelte';

  let { show }: { show: boolean } = $props();
</script>

{#if show}
  <Heavy label="x" />
{/if}

<p>mid</p>
