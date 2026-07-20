<script>
  import Child from './Child.svelte';
  let dyn = Math.random() > 0.5 ? 'p' : 'q';
</script>

<button class="btn">x</button>
<Child><div class={dyn}>ignored</div></Child>

<style>
  .btn { font: inherit }
  .btn-danger { color: red }
</style>
