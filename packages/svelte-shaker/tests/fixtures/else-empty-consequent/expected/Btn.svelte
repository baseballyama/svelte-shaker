<script lang="ts">
  import Heavy from './Heavy.svelte';
  let { variant }: { variant: 'primary' | 'secondary' } = $props();
</script>

{#if variant === 'primary'}
  <b>P</b>
{:else if variant === 'secondary'}{:else}
  <Heavy />
{/if}
