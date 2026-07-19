<script lang="ts">
  let { variant }: { variant: 'primary' | 'secondary' | 'danger' } = $props();
</script>

<div class="btn btn-{variant}">
  {#if variant === 'danger'}
    <span>DANGER</span>
  {:else if variant === 'primary'}
    <b>P</b>
  {:else}
    <i>other</i>
  {/if}
</div>

<style>
  .btn-danger {
    color: red;
  }
  .btn-primary {
    color: blue;
  }
</style>
