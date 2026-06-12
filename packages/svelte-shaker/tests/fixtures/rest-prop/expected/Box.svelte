<script lang="ts">
  // `hidden` is a DECLARED prop; `...rest` only captures UNDECLARED props
  // (`id`, `class` below). Folding/dropping `hidden` is sound despite `rest`.
  let { ...rest }: { [key: string]: unknown } =
    $props();
</script>

<div {...rest}>
  <span>hidden flag is set</span>
  <p>Box content</p>
</div>
