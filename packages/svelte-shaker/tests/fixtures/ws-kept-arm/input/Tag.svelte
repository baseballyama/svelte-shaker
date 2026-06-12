<script lang="ts">
  let { on }: { on: boolean } = $props();
</script>

<div><p>a</p>{#if on} <b>x</b>{/if}<p>c</p></div>
