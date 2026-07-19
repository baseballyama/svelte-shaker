<script>
  let { label, extra, ...rest } = $props();
</script>
<span>{label}|{Object.keys(rest).join(',')}</span>
