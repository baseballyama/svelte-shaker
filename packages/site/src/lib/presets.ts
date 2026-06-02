import type { Files } from './engine';

export interface Preset {
  id: string;
  name: string;
  blurb: string;
  l2: boolean; // whether L2 is worth turning on for this one
  files: Files;
}

export const presets: Preset[] = [
  {
    id: 'props',
    name: 'Unused props',
    blurb:
      'A 6-prop design-system Button used with two. The unused props fold to their defaults and vanish — markup, classes, and the props themselves.',
    l2: false,
    files: {
      'App.svelte': `<script>
  import Button from './Button.svelte';
</script>

<Button variant="primary" loading={false}>Save</Button>
`,
      'Button.svelte': `<script lang="ts">
  let {
    variant = 'primary',
    size = 'md',
    loading = false,
    icon = null,
    fullWidth = false,
    children,
  }: {
    variant?: 'primary' | 'secondary';
    size?: 'sm' | 'md' | 'lg';
    loading?: boolean;
    icon?: string | null;
    fullWidth?: boolean;
    children?: any;
  } = $props();
</script>

<button class="btn btn-{variant} btn-{size}" class:full={fullWidth}>
  {#if loading}<span class="spinner"></span>{/if}
  {#if icon}<i class="ico">{icon}</i>{/if}
  {@render children?.()}
</button>
`,
    },
  },
  {
    id: 'variant',
    name: 'Variant + dead CSS',
    blurb:
      'Across the app, `tone` is only ever "ok" or "warn". The "danger" branch can never run — and the `.tag-danger` CSS rule can never match. Both go. (A bundler can\'t reach this.)',
    l2: false,
    files: {
      'App.svelte': `<script>
  import Tag from './Tag.svelte';
</script>

<Tag tone="ok">Shipped</Tag>
<Tag tone="warn">Pending</Tag>
`,
      'Tag.svelte': `<script lang="ts">
  let {
    tone = 'ok',
    children,
  }: { tone?: 'ok' | 'warn' | 'danger'; children?: any } = $props();
</script>

<span class="tag tag-{tone}">
  {#if tone === 'danger'}<b class="bang">!</b>{/if}
  {@render children?.()}
</span>

<style>
  .tag {
    padding: 2px 9px;
    border-radius: 999px;
    font: 600 12px monospace;
  }
  .tag-ok {
    background: #11331f;
    color: #ff3e00;
  }
  .tag-warn {
    background: #332611;
    color: #ffb454;
  }
  .tag-danger {
    background: #331111;
    color: #ff5d5d;
  }
  .bang {
    margin-right: 4px;
  }
</style>
`,
    },
  },
  {
    id: 'cascade',
    name: 'Whole-program cascade',
    blurb:
      'The app never shows the chart, so the `{#if}` folds away — taking the `<Chart>` call site with it. Chart.svelte is now imported by no one and drops out entirely.',
    l2: false,
    files: {
      'App.svelte': `<script>
  import Panel from './Panel.svelte';
</script>

<Panel showChart={false} title="Overview" />
`,
      'Panel.svelte': `<script lang="ts">
  import Chart from './Chart.svelte';
  let {
    showChart = false,
    title,
  }: { showChart?: boolean; title: string } = $props();
</script>

<section>
  <h2>{title}</h2>
  {#if showChart}<Chart series={[4, 9, 6, 12]} />{/if}
</section>
`,
      'Chart.svelte': `<script lang="ts">
  let { series }: { series: number[] } = $props();
</script>

<svg viewBox="0 0 64 40">
  {#each series as v, i}
    <rect x={i * 16} y={40 - v * 3} width="12" height={v * 3} fill="#ff3e00" />
  {/each}
</svg>
`,
    },
  },
  {
    id: 'l2',
    name: 'L2 · correlated condition',
    blurb:
      'A heavy widget is gated on `row === 1 && col === 1`. App-wide `row` and `col` are each {0,1}, so per-prop narrowing can\'t kill it — but no cell is ever (1,1). Turn on L2: each call site is specialized, the widget is orphaned, and it drops from the bundle.',
    l2: true,
    files: {
      'App.svelte': `<script>
  import Cell from './Cell.svelte';
</script>

<Cell row={0} col={1} />
<Cell row={1} col={0} />
`,
      'Cell.svelte': `<script lang="ts">
  import Heavy from './Heavy.svelte';
  let { row, col }: { row: number; col: number } = $props();
</script>

<div class="cell">
  {#if row === 1 && col === 1}<Heavy />{/if}
  <code>({row}, {col})</code>
</div>
`,
      'Heavy.svelte': `<script lang="ts">
  // Pretend this is a big editor only the (1,1) cell needs.
  const cells = Array.from({ length: 48 }, (_, i) => i);
</script>

<div class="heavy">
  {#each cells as n}<span class="px">HEAVY_WIDGET_{n}</span>{/each}
</div>

<style>
  .px {
    display: inline-block;
    width: 9px;
    height: 9px;
    background: #ff3e00;
  }
</style>
`,
    },
  },
];

export function clonePresetFiles(p: Preset): Files {
  return { ...p.files };
}
