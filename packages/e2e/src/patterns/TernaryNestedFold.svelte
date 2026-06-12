<script lang="ts">
  // Pattern 4: folded prop referenced inside the taken arm of a ternary
  // ("fold-nested").  Svelte 5 disallows genuine nested destructuring in
  // $props(), so this pattern tests the next closest thing: both `flag` and
  // `text` default and fold, then `{flag ? text : 'none'}` collapses to its
  // taken arm, which itself contains the folded `text`.  The shaker must
  // substitute `text` into that emitted arm — not leave a dangling reference.
  let { flag = true, text = 'hello' }: { flag?: boolean; text?: string } = $props();
</script>

<p data-nested="true">{flag ? text : 'none'}</p>
