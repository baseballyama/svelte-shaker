<script>
  import Toggle from './Toggle.svelte';
  let count = $state(0);
</script>
<Toggle {count} />
