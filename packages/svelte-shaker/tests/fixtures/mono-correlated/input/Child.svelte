<script lang="ts">
  import Heavy from './Heavy.svelte';
  let { a, b }: { a: number; b: number } = $props();
</script>

{#if a === 1 && b === 1}<Heavy />{/if}<p>base</p>
