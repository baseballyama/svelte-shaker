<script>
  import Icon from './Icon.svelte';
  import Heavy from './Heavy.svelte';
  const glyph = 'star';
  let label = $state('hi');
</script>
<Icon label={label} />
<Icon label={label}></Icon>
