<script lang="ts">
  // Pattern 5: rest props + spread at call site.
  // `hidden` is a declared prop (always passed false → folds and drops).
  // `...rest` captures undeclared props (`id`, `class`) and must survive.
  let { hidden, ...rest }: { hidden: boolean; [key: string]: unknown } = $props();
</script>

<div {...rest}>
  {#if hidden}
    <span class="hidden-flag">hidden flag is set</span>
  {/if}
  <p>rest-props content</p>
</div>
