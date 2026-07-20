<script>
  import Icon from './Icon.svelte';
  import Heavy from './Heavy.svelte';
  let { glyph, label } = $props();
</script>
<Icon label={label} />
<Icon label={label}></Icon>
