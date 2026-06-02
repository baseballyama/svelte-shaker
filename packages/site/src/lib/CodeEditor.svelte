<script lang="ts">
  import { onMount } from 'svelte';
  import { getHighlighter, highlightSvelte } from './highlight';

  let {
    value,
    oninput,
    onkeydown,
  }: {
    value: string;
    oninput: (e: Event & { currentTarget: EventTarget & HTMLTextAreaElement }) => void;
    onkeydown?: (e: KeyboardEvent & { currentTarget: EventTarget & HTMLTextAreaElement }) => void;
  } = $props();

  let html = $state('');
  let ready = $state(false);
  // `$state` so the effect below re-runs once the async highlighter resolves.
  let hl = $state<Awaited<ReturnType<typeof getHighlighter>> | null>(null);
  let ta = $state<HTMLTextAreaElement>();
  let overlay = $state<HTMLDivElement>();

  onMount(async () => {
    try {
      hl = await getHighlighter();
    } catch {
      // Leave the plain textarea visible if highlighting can't load.
    }
  });

  // Repaint whenever the highlighter loads or the source changes — synchronous
  // once `hl` is set. `ready` only flips after a successful paint, so the plain
  // textarea stays visible until the overlay actually has content.
  $effect(() => {
    if (!hl) return;
    try {
      html = highlightSvelte(hl, value);
      ready = true;
    } catch {
      ready = false;
    }
  });

  // Keep the (transparent-text) textarea and the highlighted overlay in lockstep.
  function syncScroll(): void {
    const pre = overlay?.querySelector('pre');
    if (pre && ta) {
      pre.scrollTop = ta.scrollTop;
      pre.scrollLeft = ta.scrollLeft;
    }
  }
</script>

<div class="code-edit" class:ready>
  <div class="overlay" bind:this={overlay} aria-hidden="true">{@html html}</div>
  <textarea
    bind:this={ta}
    class="ta"
    spellcheck="false"
    {value}
    {oninput}
    {onkeydown}
    onscroll={syncScroll}
  ></textarea>
</div>

<style>
  .code-edit {
    position: relative;
    flex: 1;
    min-height: 0;
  }
  .overlay {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
  }
  /* The generated `<pre class="shiki">` IS the visible code; match the textarea
     metrics exactly so the transparent textarea text sits on top pixel-for-pixel. */
  .overlay :global(pre.shiki) {
    margin: 0;
    padding: 12px 14px;
    height: 100%;
    overflow: auto;
    scrollbar-width: none;
    background: transparent !important;
    font-family: var(--mono);
    font-size: 13px;
    line-height: 1.7;
    tab-size: 2;
    white-space: pre;
  }
  .overlay :global(pre.shiki::-webkit-scrollbar) {
    display: none;
  }
  .ta {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    border: 0;
    outline: 0;
    resize: none;
    background: transparent;
    color: transparent;
    caret-color: var(--ink);
    padding: 12px 14px;
    font-family: var(--mono);
    font-size: 13px;
    line-height: 1.7;
    tab-size: 2;
    white-space: pre;
    overflow: auto;
  }
  /* Until the highlighter loads, show the textarea's own text (no overlay yet). */
  .code-edit:not(.ready) .ta {
    color: var(--ink);
  }

  /* Dual-theme: shiki emits `--shiki-dark` per token; swap to it under dark mode. */
  :global([data-theme='dark']) .overlay :global(pre.shiki),
  :global([data-theme='dark']) .overlay :global(pre.shiki span) {
    color: var(--shiki-dark) !important;
  }
</style>
