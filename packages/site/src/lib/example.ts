import type { Files } from './engine';

// The one example the playground opens with. It compresses the whole pitch
// into three files: `variant` is one constant app-wide (folds, and takes the
// `.btn-danger` CSS with it), `loading` is never passed (its `{#if}` dies, so
// Spinner.svelte is imported by no one and drops from the bundle).
export const exampleFiles: Files = {
  'App.svelte': `<script>
  import Button from './Button.svelte';
</script>

<Button variant="primary">Save</Button>
<Button variant="primary">Cancel</Button>
`,
  'Button.svelte': `<script lang="ts">
  import Spinner from './Spinner.svelte';
  let {
    variant = 'primary',
    loading = false,
    children,
  }: {
    variant?: 'primary' | 'danger';
    loading?: boolean;
    children?: any;
  } = $props();
</script>

<button class="btn btn-{variant}">
  {#if loading}<Spinner />{/if}
  {@render children?.()}
</button>

<style>
  .btn {
    padding: 6px 14px;
    border: 0;
    border-radius: 6px;
    font: 600 13px sans-serif;
  }
  .btn-primary {
    background: #ff3e00;
    color: #fff;
  }
  .btn-danger {
    background: #b91c1c;
    color: #fff;
  }
</style>
`,
  'Spinner.svelte': `<span class="spinner"></span>

<style>
  .spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid #fff5;
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
`,
};

export function cloneExampleFiles(): Files {
  return { ...exampleFiles };
}
