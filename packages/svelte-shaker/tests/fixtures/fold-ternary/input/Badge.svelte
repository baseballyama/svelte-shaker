<script lang="ts">
  let { isActive }: { isActive: boolean } = $props();
</script>

<span class:active={isActive} data-state={isActive}>
  {isActive ? 'on' : 'off'}
</span>
