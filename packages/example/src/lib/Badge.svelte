<script lang="ts">
  // Both call sites in App.svelte pass the same `variant` literal, so this
  // prop constant-folds to `'info'`: it's dropped from the $props()
  // signature, the `variant === 'warning'` branch below is dead and gets
  // removed, and `.badge-warning-flag` (only reachable from that branch)
  // is pruned from <style>.
  let { label, variant = 'info' }: { label: string; variant?: 'info' | 'warning' } =
    $props();
</script>

<span class="badge">
  {label}
  {#if variant === 'warning'}
    <strong class="badge-warning-flag">!</strong>
  {/if}
</span>

<style>
  .badge {
    display: inline-block;
    padding: 0.15em 0.6em;
    border-radius: 999px;
    font-size: 0.8em;
    background: #e0f2fe;
    color: #075985;
  }
  .badge-warning-flag {
    margin-left: 0.25em;
    color: #dc2626;
  }
</style>
