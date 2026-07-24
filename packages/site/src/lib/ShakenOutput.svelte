<script lang="ts">
  import type { ShakeOutput, Files } from './engine';
  import { diffLines, hasChanges, type DiffLine } from './diff';

  let {
    files,
    fileNames,
    result,
  }: { files: Files; fileNames: string[]; result: ShakeOutput | null } = $props();

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
</script>

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
              >{:else}{fd.name}{#if !fd.changed}<span class="nochange">· unchanged</span
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
            + {result.variants.length} specialized variant module{result.variants.length > 1
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

<style>
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
  .legend {
    font-size: 12.5px;
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
    font-size: 15px;
  }
  .file {
    margin: 4px 0 10px;
  }
  .file.dim {
    opacity: 0.55;
  }
  .file-name {
    font-size: 12.5px;
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
    font-size: 12px;
  }
  .diff {
    margin: 0;
    font-size: 13.5px;
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
    font-size: 12.5px;
  }

  @media (max-width: 860px) {
    .col {
      min-height: 300px;
    }
  }
</style>
