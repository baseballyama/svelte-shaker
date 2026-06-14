<script lang="ts">
  import C from './C.svelte';

  // A statically-known object-literal spread: svelte-shaker can see its full key
  // set, so it expands `{...{variant, size}}` into `variant='primary' size={1}`
  // and folds both — exactly as if they had been written as attributes. An opaque
  // spread (`{...someVar}`) would instead poison every prop it might set.
</script>

<C {...{ variant: 'primary', size: 1 }} />
