<script lang="ts">
  import Box from './Box.svelte';
</script>

<!-- `hidden` is declared (folds & drops); `id` / `class` are undeclared and
     flow through Box's `...rest` to the inner <div>, so they must survive. -->
<Box hidden={true} id="x" class="box" />
