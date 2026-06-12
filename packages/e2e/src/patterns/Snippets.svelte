<script lang="ts">
  // Pattern 9: snippets + {#each} with a shadowing name.
  // The snippet parameter `sep` shadows the outer `const sep` from the script
  // block.  The shaker must not conflate these two bindings when deciding
  // whether the outer `sep` is live.
  let { items = ['alpha', 'beta', 'gamma'] }: { items?: string[] } = $props();
  const sep = ': ';
</script>

{#snippet label(sep: string, text: string)}
  <span class="label">{sep}{text}</span>
{/snippet}

<ul>
  {#each items as item, i}
    <li>{@render label(`${i + 1}`, item)}</li>
  {/each}
</ul>

<p class="footer">separator in outer scope: {sep}</p>
