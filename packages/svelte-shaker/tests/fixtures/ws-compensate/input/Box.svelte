<script lang="ts">
  let { hidden }: { hidden: boolean } = $props();
</script>

<div>
  {#if hidden}
    <span>flag</span>
  {/if}
  <p>content</p>
</div>
