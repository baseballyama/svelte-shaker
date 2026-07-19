<script lang="ts">
  import { shake, type ShakeOutput, type Files } from './engine';
  import { diffLines, hasChanges, type DiffLine } from './diff';
  import { cloneExampleFiles } from './example';
  import CodeEditor from './CodeEditor.svelte';

  let files = $state<Files>(cloneExampleFiles());
  let activeFile = $state<string>('App.svelte');
  let result = $state<ShakeOutput | null>(null);
  let running = $state(false);

  const fileNames = $derived(Object.keys(files));

  // Re-shake (debounced) whenever the source changes — fully client, full mode.
  let timer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const snapshot = $state.snapshot(files) as Files;
    running = true;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const out = await shake(snapshot, true);
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
    dropped: boolean;
  }
  const diffs = $derived.by<FileDiff[]>(() => {
    if (!result) return [];
    const out: FileDiff[] = [];
    for (const name of fileNames) {
      const after = result.shaken[name];
      if (after === undefined) continue;
      const lines = diffLines(files[name]!, after);
      const dropped = result.dropped.includes(name);
      out.push({ name, lines, changed: hasChanges(lines), dropped });
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

<div class="pg">
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
      <CodeEditor
        value={files[activeFile] ?? ''}
        onkeydown={onTab}
        oninput={(e) => onEdit(activeFile, e.currentTarget.value)}
      />
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
            <div class="file" class:dim={!fd.changed && !fd.dropped}>
              <div class="file-name">
                {#if fd.dropped}<s>{fd.name}</s><span class="droptag"
                    >dropped from the bundle</span
                  >{:else}{fd.name}{#if !fd.changed}<span class="nochange"
                      >· unchanged</span
                    >{/if}{/if}
              </div>
              {#if !fd.dropped}
                <pre class="diff">{#each fd.lines as ln}<span class="ln {ln.kind}"
                      ><span class="gut"
                        >{ln.kind === 'del'
                          ? '−'
                          : ln.kind === 'add'
                            ? '+'
                            : ' '}</span
                      >{ln.text}
</span>{/each}</pre>
              {/if}
            </div>
          {/each}
          {#if result && result.variants.length > 0}
            <div class="file">
              <div class="file-name">
                + {result.variants.length} specialized variant module{result
                  .variants.length > 1
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
</div>

<style>
  .pg {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  /* size headline */
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
    font-size: 14px;
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
    font-size: 13px;
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
    font-size: 13px;
    color: var(--ink-dim);
  }
  .bailed {
    margin-top: 6px;
    font-size: 13px;
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
    min-height: 460px;
    overflow: hidden;
  }
  .col-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 9px 14px;
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
    font-size: 12.5px;
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
    font-size: 12px;
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

  .out {
    flex: 1;
    overflow: auto;
    padding: 8px 0;
  }
  .empty {
    color: var(--ink-faint);
    padding: 18px;
    font-size: 14px;
  }
  .file {
    margin: 4px 0 10px;
  }
  .file.dim {
    opacity: 0.55;
  }
  .file-name {
    font-size: 12px;
    color: var(--ink-dim);
    padding: 4px 14px;
    letter-spacing: 0.03em;
  }
  .nochange {
    color: var(--ink-faint);
    margin-left: 6px;
  }
  .file-name s {
    color: var(--del);
    text-decoration-color: color-mix(in srgb, var(--del) 55%, transparent);
  }
  .droptag {
    margin-left: 8px;
    color: var(--del);
    background: var(--del-bg);
    border-radius: 5px;
    padding: 1px 7px;
    font-size: 11px;
  }
  .diff {
    margin: 0;
    font-size: 13px;
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
    border-left: 2px solid var(--accent);
    margin: 4px 12px;
    background: var(--bg-1);
    border-radius: 0 6px 6px 0;
  }
  .vid {
    color: var(--accent);
    font-size: 12px;
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
