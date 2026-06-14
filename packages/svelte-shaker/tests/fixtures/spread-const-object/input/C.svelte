<script lang="ts">
  let { variant, size }: { variant: string; size: number } = $props();
</script>

{#if variant === 'primary'}
  <p>primary</p>
{:else}
  <p>other</p>
{/if}

{#if size === 1}
  <p>one</p>
{/if}
