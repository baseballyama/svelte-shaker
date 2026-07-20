<script>
  import Icon from './Icon.svelte';
  import Heavy from './Heavy.svelte';
  let { glyph, label } = $props();
</script>
<Icon icon={glyph} label={label} />
<Icon label={label}><Heavy /></Icon>
