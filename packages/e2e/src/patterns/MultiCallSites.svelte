<script lang="ts">
  // Pattern 6: prop passed the same constant from multiple call sites.
  // App renders this component twice, both times with variant="primary".
  // The shaker should fold `variant` to "primary" at both sites.
  let { variant }: { variant: 'primary' | 'secondary' | 'ghost' } = $props();
</script>

<button class="btn btn-{variant}">{variant}</button>
