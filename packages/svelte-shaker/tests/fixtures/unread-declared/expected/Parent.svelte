<script>
  import GrandChild from './GrandChild.svelte';
  let { label } = $props();
</script>
<GrandChild inner={label} />
