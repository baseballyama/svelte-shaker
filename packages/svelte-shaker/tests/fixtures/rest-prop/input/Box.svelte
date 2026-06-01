<script lang="ts">
  // `hidden` is a DECLARED prop; `...rest` only captures UNDECLARED props
  // (`id`, `class` below). Folding/dropping `hidden` is sound despite `rest`.
  let { hidden, ...rest }: { hidden: boolean; [key: string]: unknown } =
    $props();
</script>

<div {...rest}>
  {#if hidden}
    <span>hidden flag is set</span>
  {/if}
  <p>Box content</p>
</div>
