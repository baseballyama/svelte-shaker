<script lang="ts">
  let { hasIcon }: { hasIcon: boolean } = $props();
</script>

{#if hasIcon}
  <p>Icon</p>
{/if}

<p>This is Sub Component</p>
