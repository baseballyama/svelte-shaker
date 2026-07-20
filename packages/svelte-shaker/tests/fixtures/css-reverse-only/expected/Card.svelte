<script>
  import Child from './Child.svelte';
  let dyn = Math.random() > 0.5 ? 'p' : 'q';
</script>

<button class="btn">x</button>
<Child></Child>

<style>
  .btn { font: inherit }
</style>
