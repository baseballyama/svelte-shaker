<script lang="ts">
  let { a }: { a: number; } = $props();
</script>

{#if a === 1}
  <p>A is one</p>
{/if}


  <p>B is truthy</p>


<p>C base</p>
