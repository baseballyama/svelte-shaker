<script>
  import Card from './Card.svelte';
  import Badge from './Badge.svelte';
  const heavy = 'H';
  let title = $state('hello');
</script>
<Card title={title} />
<Badge label={title} />
