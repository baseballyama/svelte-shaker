<script lang="ts">
  import Child from './Child.svelte';
  let { variant }: { variant: 'primary' | 'secondary' } = $props();
</script>

<Child variant={variant} />
