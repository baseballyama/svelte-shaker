<script lang="ts">
  let { a, b }: { a: number; b: number } = $props();
</script>

{#if a === 1}
  <p>A is one</p>
{/if}

{#if b}
  <p>B is truthy</p>
{/if}

<p>C base</p>
