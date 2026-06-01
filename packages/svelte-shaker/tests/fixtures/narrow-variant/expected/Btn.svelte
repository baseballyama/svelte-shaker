<script lang="ts">
  let { variant }: { variant: 'primary' | 'secondary' | 'danger' } = $props();
</script>

{#if variant === 'primary'}
  <b>P</b>
{:else}
  <i>other</i>
{/if}
