<script>
  import Aria from './Aria.svelte';
  import Sub from './Sub.svelte';
  import { writable } from 'svelte/store';
  let { glyph, label } = $props();
  const pinged = writable('P');
</script>
<Aria aria-label="hello" icon={glyph} label={label} />
<Sub ping={$pinged} label={label} />
