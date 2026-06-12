<script lang="ts">
  // Pattern 7: ternary folding in the template.
  // `isActive` is always false → the shaker folds `isActive ? 'on' : 'off'` to
  // `'off'` and removes the conditional class and data-attribute bindings.
  let { isActive }: { isActive: boolean } = $props();
</script>

<span class:active={isActive} data-state={isActive ? 'active' : 'inactive'}>
  {isActive ? 'on' : 'off'}
</span>
