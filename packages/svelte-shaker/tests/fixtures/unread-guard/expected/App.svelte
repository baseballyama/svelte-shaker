<script>
  import Aria from './Aria.svelte';
  import Sub from './Sub.svelte';
  import { writable } from 'svelte/store';
  const glyph = 'star';
  const pinged = writable('P');
  let label = $state('hi');
</script>
<Aria aria-label="hello" icon={glyph} label={label} />
<Sub ping={$pinged} label={label} />
