<script lang="ts">
  import { shake, type ShakeOutput, type Files } from './engine';
  import { diffLines, hasChanges, type DiffLine } from './diff';
  import { presets, clonePresetFiles, type Preset } from './presets';

  let activePreset = $state<Preset>(presets[0]!);
  let files = $state<Files>(clonePresetFiles(presets[0]!));
  let activeFile = $state<string>('App.svelte');
  // Default to "full mode" (L2 on) — the most aggressive result, for impact.
  // The toggle stays sticky across presets so you can compare.
  let l2 = $state<boolean>(true);
  let result = $state<ShakeOutput | null>(null);
  let running = $state(false);

  const fileNames = $derived(Object.keys(files));

  function loadPreset(p: Preset) {
    activePreset = p;
    files = clonePresetFiles(p);
    activeFile = 'App.svelte';
    // L2 stays as the user left it (full mode by default).
  }

  // Re-shake (debounced) whenever the source or L2 toggle changes — fully client.
  let timer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const snapshot = $state.snapshot(files) as Files;
    const useL2 = l2;
    running = true;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const out = await shake(snapshot, useL2);
      result = out;
      running = false;
    }, 200);
  });

  function onEdit(name: string, value: string) {
    files = { ...files, [name]: value };
  }

  function onTab(e: KeyboardEvent) {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const ta = e.currentTarget as HTMLTextAreaElement;
    const s = ta.selectionStart;
    const v = ta.value;
    ta.value = v.slice(0, s) + '  ' + v.slice(ta.selectionEnd);
    ta.selectionStart = ta.selectionEnd = s + 2;
    onEdit(activeFile, ta.value);
  }

  // ---- derived view models ----
  interface FileDiff {
    name: string;
    lines: DiffLine[];
    changed: boolean;
  }
  const diffs = $derived.by<FileDiff[]>(() => {
    if (!result) return [];
    const out: FileDiff[] = [];
    for (const name of fileNames) {
      const after = result.shaken[name];
      if (after === undefined) continue;
      const lines = diffLines(files[name]!, after);
      out.push({ name, lines, changed: hasChanges(lines) });
    }
    return out;
  });

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
</script>

<div class="pg">
  <!-- toolbar -->
  <div class="bar">
    <div class="presets">
      {#each presets as p (p.id)}
        <button
          class="chip"
          class:on={activePreset.id === p.id}
          onclick={() => loadPreset(p)}>{p.name}</button
        >
      {/each}
    </div>
    <label class="l2" class:on={l2}>
      <input type="checkbox" bind:checked={l2} />
      <span class="track"><span class="thumb"></span></span>
      <span class="l2-label">L2 monomorphize</span>
    </label>
  </div>

  <p class="blurb">{activePreset.blurb}</p>

  <!-- size headline -->
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
      <div class="track2">
        <div class="fill" style:width="{afterFrac * 100}%"></div>
      </div>
    {:else}
      <div class="size-nums"><span class="meta">compiling…</span></div>
    {/if}
    {#if running}<span class="spin" aria-hidden="true"></span>{/if}
  </div>

  <!-- editor | output -->
  <div class="grid">
    <section class="col">
      <div class="col-head">
        <span class="mono-label">input</span>
        <div class="tabs">
          {#each fileNames as name (name)}
            <button
              class="tab"
              class:on={activeFile === name}
              onclick={() => (activeFile = name)}>{name}</button
            >
          {/each}
        </div>
      </div>
      <textarea
        class="editor"
        spellcheck="false"
        value={files[activeFile]}
        onkeydown={onTab}
        oninput={(e) => onEdit(activeFile, e.currentTarget.value)}
      ></textarea>
    </section>

    <section class="col">
      <div class="col-head">
        <span class="mono-label">shaken output</span>
        <span class="legend"
          ><i class="sw del"></i>removed <i class="sw add"></i>added</span
        >
      </div>
      <div class="out">
        {#if result?.error}
          <div class="empty">Fix the error above to see the shaken output.</div>
        {:else}
          {#each diffs as fd (fd.name)}
            <div class="file" class:dim={!fd.changed}>
              <div class="file-name">
                {fd.name}{#if !fd.changed}<span class="nochange"
                    >· unchanged</span
                  >{/if}
              </div>
              <pre class="diff">{#each fd.lines as ln}<span class="ln {ln.kind}"
                    ><span class="gut"
                      >{ln.kind === 'del'
                        ? '−'
                        : ln.kind === 'add'
                          ? '+'
                          : ' '}</span
                    >{ln.text}
</span>{/each}</pre>
            </div>
          {/each}
          {#if result && result.variants.length > 0}
            <div class="file">
              <div class="file-name">
                + {result.variants.length} L2 variant module{result.variants
                  .length > 1
                  ? 's'
                  : ''}
              </div>
              {#each result.variants as v (v.id)}
                <pre class="diff variant"><span class="vid">{v.id}</span>
{v.code}</pre>
              {/each}
            </div>
          {/if}
        {/if}
      </div>
    </section>
  </div>

  <!-- eliminated summary -->
  {#if result && !result.error}
    {@const e = result.eliminated}
    <div class="elim">
      <span class="mono-label">eliminated</span>
      <div class="stats">
        <span class="stat" class:nil={e.propsFolded === 0}
          ><b>{e.propsFolded}</b> props folded</span
        >
        <span class="stat" class:nil={e.propsNarrowed === 0}
          ><b>{e.propsNarrowed}</b> props narrowed</span
        >
        <span class="stat" class:nil={e.deadBranches === 0}
          ><b>{e.deadBranches}</b> dead branches</span
        >
        <span class="stat" class:nil={e.cssRules === 0}
          ><b>{e.cssRules}</b> CSS rules</span
        >
        <span class="stat" class:nil={e.componentsDropped === 0}
          ><b>{e.componentsDropped}</b> modules dropped</span
        >
      </div>
      {#if e.bailed.length > 0}
        <div class="bailed">
          bailed (kept safe): {e.bailed.join(', ')}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .pg {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  /* toolbar */
  .bar {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
  }
  .presets {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    background: var(--bg-2);
    border: 1px solid var(--line);
    color: var(--ink-dim);
    padding: 6px 11px;
    border-radius: 7px;
    font-size: 12.5px;
    transition:
      color 0.15s,
      border-color 0.15s,
      background 0.15s;
  }
  .chip:hover {
    color: var(--ink);
    border-color: var(--line-2);
  }
  .chip.on {
    color: var(--bg);
    background: var(--accent);
    border-color: var(--accent);
    font-weight: 700;
  }

  .l2 {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    user-select: none;
  }
  .l2 input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }
  .track {
    width: 34px;
    height: 18px;
    border-radius: 999px;
    background: var(--line-2);
    position: relative;
    transition: background 0.18s;
  }
  .thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--ink-dim);
    transition:
      transform 0.18s,
      background 0.18s;
  }
  .l2.on .track {
    background: color-mix(in srgb, var(--accent) 30%, transparent);
  }
  .l2.on .thumb {
    transform: translateX(16px);
    background: var(--accent);
  }
  .l2-label {
    font-size: 12.5px;
    color: var(--ink-dim);
  }
  .l2.on .l2-label {
    color: var(--ink);
  }

  .blurb {
    margin: 0;
    color: var(--ink-dim);
    font-size: 13px;
    max-width: 80ch;
    line-height: 1.65;
  }
  .blurb :global(code) {
    color: var(--accent);
    background: var(--accent-bg);
    padding: 1px 4px;
    border-radius: 4px;
  }

  /* size headline */
  .size {
    border: 1px solid var(--line);
    background: linear-gradient(var(--bg-1), var(--bg));
    border-radius: var(--r);
    padding: 14px 16px;
    position: relative;
    overflow: hidden;
  }
  .size.err {
    border-color: color-mix(in srgb, var(--del) 40%, transparent);
  }
  .size-err {
    color: var(--del);
    font-size: 13px;
  }
  .size-nums {
    display: flex;
    align-items: baseline;
    gap: 12px;
    flex-wrap: wrap;
  }
  .from {
    color: var(--ink-dim);
    font-size: 18px;
  }
  .arrow {
    color: var(--ink-faint);
  }
  .to {
    color: var(--accent);
    font-size: 26px;
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
    font-size: 13px;
  }
  .pct.zero {
    color: var(--ink-faint);
    border-color: var(--line-2);
    background: transparent;
  }
  .meta {
    color: var(--ink-faint);
    font-size: 12px;
    margin-left: auto;
  }
  .track2 {
    margin-top: 10px;
    height: 8px;
    border-radius: 6px;
    background: var(--line-2);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: linear-gradient(90deg, var(--accent-deep), var(--accent));
    border-radius: 6px;
    transition: width 0.5s cubic-bezier(0.22, 1, 0.36, 1);
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

  /* grid */
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
  }
  .col {
    border: 1px solid var(--line);
    border-radius: var(--r);
    background: var(--panel);
    display: flex;
    flex-direction: column;
    min-height: 420px;
    overflow: hidden;
  }
  .col-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 9px 12px;
    border-bottom: 1px solid var(--line);
    background: var(--bg-1);
  }
  .tabs {
    display: flex;
    gap: 2px;
    flex-wrap: wrap;
  }
  .tab {
    background: transparent;
    border: 0;
    color: var(--ink-faint);
    font-size: 12px;
    padding: 3px 8px;
    border-radius: 6px;
    transition: color 0.12s;
  }
  .tab:hover {
    color: var(--ink-dim);
  }
  .tab.on {
    color: var(--accent);
    background: var(--accent-bg);
  }
  .legend {
    font-size: 11px;
    color: var(--ink-faint);
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .sw {
    width: 9px;
    height: 9px;
    border-radius: 2px;
    display: inline-block;
    margin: 0 3px 0 8px;
  }
  .sw.del {
    background: var(--del);
  }
  .sw.add {
    background: var(--add);
  }

  .editor {
    flex: 1;
    border: 0;
    outline: 0;
    resize: none;
    background: transparent;
    color: var(--ink);
    padding: 12px 14px;
    font-size: 13px;
    line-height: 1.7;
    tab-size: 2;
    white-space: pre;
    overflow: auto;
  }

  .out {
    flex: 1;
    overflow: auto;
    padding: 8px 0;
  }
  .empty {
    color: var(--ink-faint);
    padding: 18px;
    font-size: 13px;
  }
  .file {
    margin: 4px 0 10px;
  }
  .file.dim {
    opacity: 0.5;
  }
  .file-name {
    font-size: 11px;
    color: var(--ink-dim);
    padding: 4px 14px;
    letter-spacing: 0.03em;
  }
  .nochange {
    color: var(--ink-faint);
    margin-left: 6px;
  }
  .diff {
    margin: 0;
    font-size: 12.5px;
    line-height: 1.65;
    overflow-x: auto;
  }
  .ln {
    display: block;
    padding-left: 14px;
    white-space: pre;
  }
  .gut {
    display: inline-block;
    width: 1.4ch;
    color: var(--ink-faint);
    user-select: none;
  }
  .ln.del {
    background: var(--del-bg);
    color: var(--del);
    text-decoration: line-through;
    text-decoration-color: color-mix(in srgb, var(--del) 50%, transparent);
  }
  .ln.del .gut {
    color: var(--del);
  }
  .ln.add {
    background: var(--add-bg);
    color: var(--add);
  }
  .ln.add .gut {
    color: var(--add);
  }
  .ln.keep {
    color: var(--ink-dim);
  }
  .variant {
    color: var(--ink-dim);
    padding: 6px 14px;
    border-left: 2px solid var(--accent-deep);
    margin: 4px 12px;
    background: var(--bg-1);
    border-radius: 0 6px 6px 0;
  }
  .vid {
    color: var(--accent);
    font-size: 11px;
  }

  /* eliminated */
  .elim {
    border: 1px solid var(--line);
    border-radius: var(--r);
    background: var(--panel);
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .stats {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 18px;
  }
  .stat {
    font-size: 13px;
    color: var(--ink-dim);
  }
  .stat b {
    font-family: var(--display);
    color: var(--accent);
    font-size: 15px;
    margin-right: 3px;
  }
  .stat.nil {
    opacity: 0.4;
  }
  .stat.nil b {
    color: var(--ink-faint);
  }
  .bailed {
    font-size: 12px;
    color: var(--ink-faint);
  }

  @media (max-width: 860px) {
    .grid {
      grid-template-columns: 1fr;
    }
    .col {
      min-height: 300px;
    }
  }
</style>
