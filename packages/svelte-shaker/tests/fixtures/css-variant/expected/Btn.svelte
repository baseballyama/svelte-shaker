<script lang="ts">
  let { variant }: { variant: 'primary' | 'secondary' | 'danger' | 'ghost' } =
    $props();
</script>

<button class="btn btn-{variant}">click</button>

<style>
  .btn {
    font: inherit;
  }
  .btn-primary {
    color: green;
  }
  .btn-secondary {
    color: teal;
  }
  button {
    padding: 4px;
  }
  .btn:hover {
    color: navy;
  }
</style>
