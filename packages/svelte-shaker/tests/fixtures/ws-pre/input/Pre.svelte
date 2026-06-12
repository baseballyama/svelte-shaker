<script lang="ts">
  let { hidden }: { hidden: boolean } = $props();
</script>

<pre>
  {#if hidden}<b>x</b>{/if}
  <p>b</p></pre>
