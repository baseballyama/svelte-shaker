<script lang="ts">
  import type { ShakeOutput } from './engine';

  let { result, running }: { result: ShakeOutput | null; running: boolean } = $props();

  const savedPct = $derived.by(() => {
    if (!result) return 0;
    const b = result.before.js + result.before.css;
    const a = result.after.js + result.after.css;
    return b === 0 ? 0 : Math.max(0, Math.round(((b - a) / b) * 100));
  });

  function kb(n: number): string {
    return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} kB`;
  }

  const afterFrac = $derived.by(() => {
    if (!result) return 1;
    const b = result.before.js + result.before.css;
    const a = result.after.js + result.after.css;
    return b === 0 ? 1 : Math.min(1, a / b);
  });

  // One quiet line: only the eliminations that actually happened.
  const elimLine = $derived.by(() => {
    const e = result?.eliminated;
    if (!e) return '';
    const parts: string[] = [];
    if (e.propsFolded) parts.push(`${e.propsFolded} props folded`);
    if (e.propsNarrowed) parts.push(`${e.propsNarrowed} props narrowed`);
    if (e.deadBranches) parts.push(`${e.deadBranches} dead branch${e.deadBranches > 1 ? 'es' : ''}`);
    if (e.cssRules) parts.push(`${e.cssRules} CSS rule${e.cssRules > 1 ? 's' : ''}`);
    if (e.componentsDropped)
      parts.push(`${e.componentsDropped} module${e.componentsDropped > 1 ? 's' : ''} dropped`);
    return parts.join(' · ');
  });
</script>

<div class="size" class:err={!!result?.error}>
  {#if result?.error}
    <div class="size-err">⚠ {result.error}</div>
  {:else if result}
    <div class="size-nums">
      <span class="from">{kb(result.before.js + result.before.css)}</span>
      <span class="arrow">→</span>
      <span class="to">{kb(result.after.js + result.after.css)}</span>
      <span class="pct" class:zero={savedPct === 0}>−{savedPct}%</span>
      <span class="meta"
        >compiled JS+CSS · {result.after.modules}/{result.before.modules} modules</span
      >
    </div>
    <div class="track">
      <div class="fill" style:width="{afterFrac * 100}%"></div>
    </div>
    {#if elimLine}
      <div class="elim">{elimLine}</div>
    {/if}
    {#if result.eliminated.bailed.length > 0}
      <div class="bailed">bailed (kept safe): {result.eliminated.bailed.join(', ')}</div>
    {/if}
  {:else}
    <div class="size-nums"><span class="meta">compiling…</span></div>
  {/if}
  {#if running}<span class="spin" aria-hidden="true"></span>{/if}
</div>

<style>
  .size {
    border: 1px solid var(--line);
    background: var(--bg-1);
    border-radius: var(--r);
    padding: 14px 18px;
    position: relative;
    overflow: hidden;
  }
  .size.err {
    border-color: color-mix(in srgb, var(--del) 40%, transparent);
  }
  .size-err {
    color: var(--del);
    font-size: 15px;
  }
  .size-nums {
    display: flex;
    align-items: baseline;
    gap: 12px;
    flex-wrap: wrap;
  }
  .from {
    color: var(--ink-dim);
    font-size: 19px;
  }
  .arrow {
    color: var(--ink-faint);
  }
  .to {
    color: var(--accent);
    font-size: 28px;
    font-weight: 700;
    font-family: var(--display);
  }
  .pct {
    font-family: var(--display);
    font-weight: 700;
    color: var(--accent);
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    background: var(--accent-bg);
    padding: 2px 8px;
    border-radius: 7px;
    font-size: 13.5px;
  }
  .pct.zero {
    color: var(--ink-faint);
    border-color: var(--line-2);
    background: transparent;
  }
  .meta {
    color: var(--ink-faint);
    font-size: 13.5px;
    margin-left: auto;
  }
  .track {
    margin-top: 10px;
    height: 6px;
    border-radius: 6px;
    background: var(--line-2);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: var(--accent);
    border-radius: 6px;
    transition: width 0.5s cubic-bezier(0.22, 1, 0.36, 1);
  }
  .elim {
    margin-top: 10px;
    font-size: 14px;
    color: var(--ink-dim);
  }
  .bailed {
    margin-top: 6px;
    font-size: 13.5px;
    color: var(--ink-faint);
  }
  .spin {
    position: absolute;
    top: 12px;
    right: 14px;
    width: 12px;
    height: 12px;
    border: 2px solid var(--line-2);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
