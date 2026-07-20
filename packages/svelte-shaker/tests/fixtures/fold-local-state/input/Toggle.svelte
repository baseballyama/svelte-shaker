<script>
  let { count = 5 } = $props();
</script>
{#if count > 0}
  <strong>positive</strong>
{/if}
<p>count is {count}</p>
