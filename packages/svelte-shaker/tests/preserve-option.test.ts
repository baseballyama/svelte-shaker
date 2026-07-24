import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build, type Rollup } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { shaker } from '../src/vite';
import { buildAnalyzeInput, findNeverPassedProps } from '../src/index';
import type { ReadFile, Resolve } from '../src/index';
import { matchPreserve } from '../src/escape-scan';

describe('matchPreserve', () => {
  const root = '/proj';
  const components = [
    '/proj/src/Button.svelte',
    '/proj/src/ui/Card.svelte',
    '/proj/src/Table.svelte',
  ];

  it('matches a directory prefix (root-relative)', () => {
    expect(matchPreserve(['src/ui'], root, components)).toEqual(['/proj/src/ui/Card.svelte']);
  });

  it('matches an exact file (absolute), and not a sibling with a shared name prefix', () => {
    // `src/Table` must NOT match `Table.svelte` by bare string prefix — only an
    // exact file or a directory boundary counts.
    expect(matchPreserve(['/proj/src/Button.svelte'], root, components)).toEqual([
      '/proj/src/Button.svelte',
    ]);
    expect(matchPreserve(['/proj/src/Tab'], root, components)).toEqual([]);
  });

  it('is a no-op for an empty / undefined list', () => {
    expect(matchPreserve(undefined, root, components)).toEqual([]);
    expect(matchPreserve([], root, components)).toEqual([]);
  });
});

describe('findNeverPassedProps respects `preserve`', () => {
  const files: Record<string, string> = {
    '/App.svelte': "<script>import W from './Widget.svelte';</script>\n<W />",
    '/Widget.svelte': '<script>let { p = false } = $props();</script>\n{#if p}x{/if}',
  };
  const resolve: Resolve = (source, importer) =>
    source.startsWith('.') ? new URL(source, `file://${importer}`).pathname : null;
  const readFile: ReadFile = (id) => files[id]!;

  it('over-reports without preserve, stays quiet once the component is preserved', async () => {
    const input = await buildAnalyzeInput(['/App.svelte', '/Widget.svelte'], resolve, readFile);
    // Nothing preserved: `p` is genuinely never passed in the `.svelte` graph → reported.
    expect(
      findNeverPassedProps(input)
        .get('/Widget.svelte')
        ?.map((u) => u.name),
    ).toEqual(['p']);
    // Preserving Widget (as an eslint shell would, via matchPreserve) makes the
    // reporter honor it automatically — it reads `input.escaped`.
    const escaped = matchPreserve(['/Widget.svelte'], '/', ['/Widget.svelte']);
    const withPreserve = { ...input, escaped };
    expect(findNeverPassedProps(withPreserve).get('/Widget.svelte')).toBeUndefined();
  });
});

// End-to-end: `preserve` keeps the prop interface of a component that would
// OTHERWISE fold (no `.ts` consumer at all), proving A-semantics — the file stays
// analyzed, its own prop is just not folded.
const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '.shaker-tmp-preserve-opt');
const IF_MACHINERY = /\bif_block\b|\$\.if\(/;

beforeAll(() => {
  rmSync(APP_DIR, { recursive: true, force: true });
  mkdirSync(APP_DIR, { recursive: true });
  const w = [
    '<script>',
    '  let { p = false } = $props();',
    '</script>',
    '',
    '{#if p}<span>P BRANCH</span>{/if}',
    '<span>base</span>',
  ].join('\n');
  writeFileSync(join(APP_DIR, 'Widget.svelte'), `${w}\n`);
  writeFileSync(
    join(APP_DIR, 'App.svelte'),
    `<script>\n  import Widget from './Widget.svelte';\n</script>\n\n<Widget />\n`,
  );
  writeFileSync(
    join(APP_DIR, 'main.ts'),
    "import { mount } from 'svelte';\nimport App from './App.svelte';\nmount(App, { target: document.body });\n",
  );
});
afterAll(() => rmSync(APP_DIR, { recursive: true, force: true }));

async function bundle(pre: unknown[]): Promise<string> {
  const result = (await build({
    root: APP_DIR,
    logLevel: 'silent',
    configFile: false,
    build: {
      write: false,
      minify: false,
      reportCompressedSize: false,
      target: 'esnext',
      rollupOptions: { input: join(APP_DIR, 'main.ts') },
    },
    plugins: [...pre, svelte({ compilerOptions: { runes: true } })] as any,
  })) as Rollup.RollupOutput;
  return result.output.map((c) => ('code' in c ? c.code : '')).join('\n');
}

describe('vite-plugin-svelte-shaker — `preserve` option', () => {
  it('folds the prop without preserve, keeps it once listed', async () => {
    const plain = await bundle([shaker({ entries: ['.'] })]);
    expect(plain).not.toContain('P BRANCH'); // no consumer passes `p` → folded away

    const preserved = await bundle([shaker({ entries: ['.'], preserve: ['./Widget.svelte'] })]);
    expect(preserved).toMatch(IF_MACHINERY);
    expect(preserved).toContain('P BRANCH'); // `preserve` kept Widget's props, so `p` survives
  });
});
