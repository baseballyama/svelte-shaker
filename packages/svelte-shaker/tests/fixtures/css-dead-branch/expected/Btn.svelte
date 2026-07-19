<script>
  let { size } = $props();
  let dyn = Math.random() > 0.5 ? 'p' : 'q';
</script>

<button class="btn btn-{size}">{size}</button>{" "}<style>
  .btn { font: inherit }
  .btn-sm { color: green }
  .btn-lg { color: teal }
</style>
