<script>
  import Card from './Card.svelte';
  import Badge from './Badge.svelte';
  import Panel from './Panel.svelte';
  import Parent from './Parent.svelte';
  let { heavy, title } = $props();
</script>
<Card title={title} />
<Badge label={title} />
<Panel c={title} />
<Parent label={title} />
