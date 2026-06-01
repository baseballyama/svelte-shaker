<script lang="ts">
  import C from './C.svelte';

  // `rest` is an opaque object, so the spread could set any prop. In source
  // order `a={1}` is BEFORE the spread (rest may override it) and `b={2}` is
  // AFTER it (rest cannot override it). svelte-shaker must reflect this.
  const rest: Record<string, unknown> = { a: 99 };
</script>

<C a={1} {...rest} />
