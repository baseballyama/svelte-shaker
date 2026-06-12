<script lang="ts">
  // Pattern 8: CSS class stripping.
  // App renders this with both "primary" and "secondary", so the shaker knows
  // `variant` ∈ {primary, secondary}.  Rules for .btn-danger and .btn-ghost
  // cannot be reached and should be stripped from the compiled CSS.
  let { variant }: { variant: 'primary' | 'secondary' | 'danger' | 'ghost' } = $props();
</script>

<button class="btn btn-{variant}">{variant}</button>

<style>
  .btn {
    font: inherit;
  }
  .btn-primary {
    color: green;
  }
  .btn-secondary {
    color: teal;
  }
  /* These two rules are dead: no call site ever produces variant="danger"
     or variant="ghost", so the shaker should strip them. */
  .btn-danger {
    color: red;
  }
  .btn-ghost {
    background: transparent;
  }
</style>
