import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build, type Rollup } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { shaker } from '../src/vite';

// A component rendered from a `.svelte` template WITHOUT `p`, but mounted from a
// `.ts` module WITH `p: true`.  The `.svelte`-only crawl cannot see `main.ts`, so
// unless the non-`.svelte` scan escapes Widget, the shaker folds `p` to its default
// and deletes the branch — breaking `mount(Widget, { props: { p: true } })`.
const BASE = join(dirname(fileURLToPath(import.meta.url)), '.shaker-tmp-external');

const WIDGET = [
  '<script lang="ts">',
  '  let { p = false }: { p?: boolean } = $props();',
  '</script>',
  '',
  '{#if p}<span>P BRANCH</span>{/if}',
  '<span>base</span>',
].join('\n');

/** Files for a build.  `mountsWidget` decides whether `main.ts` imports+mounts
 * Widget — the only difference between the escaped and foldable scenarios. */
function files(mountsWidget: boolean): Record<string, string> {
  const main = mountsWidget
    ? [
        "import { mount } from 'svelte';",
        "import Widget from './Widget.svelte';",
        "import App from './App.svelte';",
        'mount(App, { target: document.body });',
        'mount(Widget, { target: document.body, props: { p: true } });',
      ].join('\n')
    : [
        "import { mount } from 'svelte';",
        "import App from './App.svelte';",
        'mount(App, { target: document.body });',
      ].join('\n');
  return {
    'main.ts': `${main}\n`,
    'App.svelte': `<script>\n  import Widget from './Widget.svelte';\n</script>\n\n<Widget />\n`,
    'Widget.svelte': `${WIDGET}\n`,
  };
}

const IF_MACHINERY = /\bif_block\b|\$\.if\(/;

function writeApp(dir: string, content: Record<string, string>): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(content)) writeFileSync(join(dir, name), body);
}

async function bundle(dir: string, pre: unknown[]): Promise<string> {
  const result = (await build({
    root: dir,
    logLevel: 'silent',
    configFile: false,
    build: {
      write: false,
      minify: false,
      reportCompressedSize: false,
      target: 'esnext',
      rollupOptions: { input: join(dir, 'main.ts') },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    plugins: [...pre, svelte({ compilerOptions: { runes: true } })] as any,
  })) as Rollup.RollupOutput;
  return result.output.map((c) => ('code' in c ? c.code : '')).join('\n');
}

beforeAll(() => {
  writeApp(join(BASE, 'mount'), files(true));
  writeApp(join(BASE, 'nomount'), files(false));
});
afterAll(() => rmSync(BASE, { recursive: true, force: true }));

describe('vite-plugin-svelte-shaker — external (.ts) call-site scan', () => {
  it('folds `p` away when NO .ts consumer passes it (baseline)', async () => {
    const code = await bundle(join(BASE, 'nomount'), [shaker({ entries: ['.'] })]);
    // App renders <Widget/> with no `p`, and nothing else passes it → `p` folds to
    // false and the branch is removed at source, so no conditional is compiled.
    expect(code).not.toMatch(IF_MACHINERY);
    expect(code).not.toContain('P BRANCH');
    expect(code).toContain('base');
  });

  it('keeps `p` when a .ts module mounts Widget with it (scan escapes the component)', async () => {
    const code = await bundle(join(BASE, 'mount'), [shaker({ entries: ['.'] })]);
    // main.ts mounts Widget with `p: true`; the scan sees that import and escapes
    // Widget, so the branch survives and Svelte compiles the conditional.
    expect(code).toMatch(IF_MACHINERY);
    expect(code).toContain('P BRANCH');
  });

  it('JS and Rust engines scan identically (byte-identical bundle)', async () => {
    const js = await bundle(join(BASE, 'mount'), [shaker({ entries: ['.'], engine: 'js' })]);
    const rust = await bundle(join(BASE, 'mount'), [shaker({ entries: ['.'], engine: 'rust' })]);
    expect(rust).toBe(js);
    expect(rust).toContain('P BRANCH');
  });
});
