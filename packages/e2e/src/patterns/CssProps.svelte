<script lang="ts">
  // Pattern 14: non-prop call-site attributes.
  // App passes this component a CSS custom property (`--accent`) and an
  // attribute in a namespace Svelte does not define (`my:directive`).  Neither
  // is a prop this component can read, so the shaker must leave both on the call
  // site while still folding `tone` away.  The `--accent` half is what the
  // differential oracle sees: Svelte compiles it to `$.css_props(...)`, which
  // renders a real <svelte-css-wrapper> element around this component.
  let { tone = 'plain' }: { tone?: string } = $props();
</script>

<p class="accented">{tone}</p>

<style>
  .accented {
    color: var(--accent, black);
  }
</style>
