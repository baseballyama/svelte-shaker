<script>
  import Card from './Card.svelte';
  import Badge from './Badge.svelte';
  import Panel from './Panel.svelte';
  import Parent from './Parent.svelte';
  let { heavy, title } = $props();
</script>
<Card title={title} icon={heavy} />
<Badge label={title} extra={heavy} />
<Panel a={heavy} b={heavy} c={title} />
<Parent label={title} />
