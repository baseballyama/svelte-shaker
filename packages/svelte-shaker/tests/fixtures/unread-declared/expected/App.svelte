<script>
  import Card from './Card.svelte';
  import Badge from './Badge.svelte';
  import Panel from './Panel.svelte';
  import Parent from './Parent.svelte';
  const heavy = 'H';
  let title = $state('hello');
</script>
<Card title={title} />
<Badge label={title} />
<Panel c={title} />
<Parent label={title} />
