<script lang="ts">
  let { max }: { max: number } = $props();
</script>

<p>最大 {max.toLocaleString()} 件</p>
