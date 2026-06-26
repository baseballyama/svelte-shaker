import { describe, expect, it } from 'vitest';
import { svelteShaker, type ReadFile, type Resolve } from '../src/index';

// ----------------------------------------------------------------------
// A component named in a TS TYPE position — `ComponentProps<typeof Child>`,
// `: Props`, etc. — is type-level (erased at compile), NOT a runtime value use,
// so it must NOT count as an "escape" that bails the whole component. Regression
// for the flygate design-system under-shaking: `Popconfirm` referenced `Button`
// only via `ComponentProps<typeof Button>['pattern']`, which falsely escaped and
// bailed Button (and every other component referenced the same way).
// ----------------------------------------------------------------------

async function shake(files: Record<string, string>): Promise<Record<string, string>> {
  const resolve: Resolve = (source, importer) =>
    source.startsWith('.') ? new URL(source, `file://${importer}`).pathname : null;
  const readFile: ReadFile = (id) => files[id]!;
  return svelteShaker('/App.svelte', resolve, readFile);
}

const CHILD = [
  '<script lang="ts">',
  '  interface Props { extra?: boolean }',
  '  const { extra = false }: Props = $props();',
  '</script>',
  '{#if extra}<p>E</p>{/if}',
  '<p>base</p>',
].join('\n');

describe('escape detection ignores TS type positions', () => {
  it('`typeof Child` in a type does NOT bail Child — its dead branch still folds', async () => {
    const app = [
      '<script lang="ts">',
      "  import type { ComponentProps } from 'svelte';",
      "  import Child from './Child.svelte';",
      '  // `typeof Child` is type-level — must not escape Child.',
      '  type P = ComponentProps<typeof Child>;',
      '  export const _p: P = {};',
      '</script>',
      '<Child />',
    ].join('\n');
    const out = await shake({ '/App.svelte': app, '/Child.svelte': CHILD });
    // `extra` is never passed, so a non-bailed Child folds the dead `{#if}` away.
    expect(out['/Child.svelte']).not.toContain('{#if');
  });

  it('a REAL value escape still bails the component (no over-fix)', async () => {
    // Here `Child` is read as a runtime value, so its prop profile is unknowable
    // and it must be left untouched.
    const app = [
      '<script lang="ts">',
      "  import Child from './Child.svelte';",
      '  const Dyn = Child;',
      '</script>',
      '<svelte:component this={Dyn} />',
    ].join('\n');
    const out = await shake({ '/App.svelte': app, '/Child.svelte': CHILD });
    expect(out['/Child.svelte']).toContain('{#if extra}'); // untouched (bailed)
  });
});
