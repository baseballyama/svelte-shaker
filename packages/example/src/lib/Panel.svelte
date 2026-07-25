<script lang="ts">
  // No call site in App.svelte ever passes `collapsed`, so it constant-folds
  // to its default (`false`): it's dropped from the $props() signature, the
  // {#if collapsed} branch below is dead and gets removed, and
  // `.panel-collapsed-hint` (only reachable from that branch) is pruned
  // from <style>.
  let { title, collapsed }: { title: string; collapsed?: boolean } = $props();
</script>

<section class="panel">
  <h2>{title}</h2>
  {#if collapsed}
    <p class="panel-collapsed-hint">(collapsed)</p>
  {/if}
</section>

<style>
  .panel {
    border: 1px solid #d1d5db;
    border-radius: 8px;
    padding: 0.75em 1em;
  }
  .panel-collapsed-hint {
    color: #6b7280;
    font-style: italic;
  }
</style>
