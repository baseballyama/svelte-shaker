<script lang="ts">
  // Pattern 1: shorthand prop fold + dead {#if} arm.
  // `compact` is never passed by any call site (defaults to false) so the
  // shaker should fold it and delete the always-false branch.
  let { compact = false }: { compact?: boolean } = $props();
</script>

{#if compact}
  <span class="compact">compact mode</span>
{:else}
  <span class="normal">normal mode</span>
{/if}

<style>
  .compact {
    font-size: 0.8em;
  }
  .normal {
    font-size: 1em;
  }
</style>
