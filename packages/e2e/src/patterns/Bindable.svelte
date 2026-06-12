<script lang="ts">
  // Pattern 10: $bindable() prop.
  // No call site binds `count` (App passes no `bind:count`), so the shaker
  // should either fold it to 0 or bail.  Either way the rendered output must
  // be identical to the unshakenversion.
  let { count = $bindable(0) }: { count?: number } = $props();
</script>

<span data-count={count}>count: {count}</span>
