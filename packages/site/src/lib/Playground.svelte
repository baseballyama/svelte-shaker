<script lang="ts">
  import { shake, type ShakeOutput, type Files } from './engine';
  import { cloneExampleFiles } from './example';
  import CodeEditor from './CodeEditor.svelte';
  import SizeHeadline from './SizeHeadline.svelte';
  import ShakenOutput from './ShakenOutput.svelte';

  let files = $state<Files>(cloneExampleFiles());
  let activeFile = $state<string>('App.svelte');
  let result = $state<ShakeOutput | null>(null);
  let running = $state(false);

  const fileNames = $derived(Object.keys(files));

  // Re-shake (debounced) whenever the source changes — fully client, full mode.
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Guards against an in-flight `shake()` resolving after a newer call and
  // overwriting `result` with a stale answer.
  let latestGen = 0;
  $effect(() => {
    const snapshot = $state.snapshot(files) as Files;
    running = true;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const gen = ++latestGen;
      const out = await shake(snapshot, true);
      if (gen === latestGen) {
        result = out;
        running = false;
      }
    }, 200);
  });

  function onEdit(name: string, value: string) {
    files = { ...files, [name]: value };
  }

  function onTab(e: KeyboardEvent) {
    // Shift+Tab must fall through to normal focus movement — otherwise Tab
    // always inserts and traps keyboard focus inside the textarea (WCAG 2.1.2).
    if (e.key !== 'Tab' || e.shiftKey) return;
    e.preventDefault();
    const ta = e.currentTarget as HTMLTextAreaElement;
    const s = ta.selectionStart;
    const v = ta.value;
    ta.value = v.slice(0, s) + '  ' + v.slice(ta.selectionEnd);
    ta.selectionStart = ta.selectionEnd = s + 2;
    onEdit(activeFile, ta.value);
  }
</script>

<div class="pg">
  <SizeHeadline {result} {running} />

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

    <ShakenOutput {files} {fileNames} {result} />
  </div>
</div>

<style>
  .pg {
    display: flex;
    flex-direction: column;
    gap: 14px;
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
    font-size: 13px;
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

  @media (max-width: 860px) {
    .grid {
      grid-template-columns: 1fr;
    }
    .col {
      min-height: 300px;
    }
  }
</style>
