<script>
  let { loading = false } = $props();
</script>

<p>日本語テキストです</p>
{#if loading}
  <span>読み込み中</span>
{/if}

<p>base</p>
