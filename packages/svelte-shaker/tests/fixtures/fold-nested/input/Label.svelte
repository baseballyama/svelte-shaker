<script lang="ts">
  let { flag, text }: { flag: boolean; text: string } = $props();
</script>

<p>{flag ? text : 'none'}</p>
