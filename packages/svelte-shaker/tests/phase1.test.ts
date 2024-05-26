import { describe, it, expect } from 'vitest';
import { phase1 } from '../src/phase1';
import { phase2 } from '../src/phase2';
import { phase3 } from '../src/phase3';

describe('phase1', () => {
  it('should convert svelte code to js code', async () => {
    const svelteCode = `\
<script lang="ts">
  let { hasIcon, count }: { hasIcon: boolean, count: number } = $props();
</script>

{#if hasIcon}
  <p>{hasIcon}</p>
{/if}
<p>Count is {count}</p>

<style>
  p {
    color: red;
  }
</style>`;

    const jsCode = phase1(svelteCode, { hasIcon: false });

    const expected = `\
__svelte_shaker_dummy__(0, "<script lang=\\"ts\\">");
  __svelte_shaker_props_start__("let { hasIcon, count }: { hasIcon: boolean, count: number } = $props();");let hasIcon = false;let count = __svelte_shaker_props__();__svelte_shaker_props_end__();
__svelte_shaker_dummy__(93, "</script>");

{/* @@104@@__{#if hasIcon}__@@ */if (hasIcon) {
  {/* @@120@@__<p>{hasIcon}</p>
__@@ */console.log(hasIcon, hasIcon);}}/* @@137@@__{/if}__@@ */}
{/* @@143@@__<p>Count is {count}</p>
__@@ */console.log(count);}

__svelte_shaker_dummy__(168, "<style>\\n  p {\\n    color: red;\\n  }\\n</style>");`;

    // console.log('phase1 --------------------\n', jsCode);
    // const a = await phase2(jsCode);
    // console.log('phase2 --------------------\n', a);
    // const b = await phase3(a, nodeMap);
    // console.log('phase3 --------------------\n', b);

    console.log('phase1 --------------------\n', jsCode);
    expect(jsCode).toBe(expected);

    const shaked = await phase2(jsCode);
    console.log('phase2 --------------------\n', shaked);

    const final = await phase3(shaked);
    console.log('phase3 --------------------\n', final);
  });
});
