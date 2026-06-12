<script lang="ts">
  import Tag from './Tag.svelte';
</script>

<!-- `on` is proven true, so `{#if on}` collapses to its arm.  The arm's leading
     space was a block-fragment edge (trimmed); splicing it verbatim would gain a
     space, so it is stripped. -->
<Tag on={true} />
