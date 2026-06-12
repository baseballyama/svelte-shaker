<script lang="ts">
  import Pre from './Pre.svelte';
</script>

<!-- Inside <pre> whitespace is observable, so the dead `{#if}` is deleted
     verbatim with no `{" "}` compensation. -->
<Pre hidden={false} />
