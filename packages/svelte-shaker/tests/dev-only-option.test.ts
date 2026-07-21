import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build, type Rollup } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { shaker } from '../src/vite';
import {
  collectSvelteFiles,
  compileDevOnly,
  computeEscapedComponents,
  fsReadFile,
  fsResolve,
} from '../src/scan';

const BASE = join(dirname(fileURLToPath(import.meta.url)), '.shaker-tmp-dev-only');

// A tree mixing shippable components with dev-only files: colocated tests, a
// `__tests__` fixture, and a Storybook story.  DEFAULT_DEV_ONLY should discount the
// latter in both scans; `devOnly: []` should count them.
const FILES: Record<string, string> = {
  'Foo.svelte': '<p>foo</p>\n',
  'Foo.test.svelte': "<script>import Foo from './Foo.svelte';</script>\n<Foo />\n",
  'Foo.stories.svelte': "<script>import Foo from './Foo.svelte';</script>\n<Foo />\n",
  '__tests__/Fixture.svelte': '<p>fixture</p>\n',
  'Button.svelte': '<script>let { p = false } = $props();</script>\n{#if p}<b>P</b>{/if}\n',
  'Button.test.ts': "import Button from './Button.svelte';\nexport { Button };\n",
};

beforeAll(() => {
  rmSync(BASE, { recursive: true, force: true });
  mkdirSync(join(BASE, '__tests__'), { recursive: true });
  for (const [name, content] of Object.entries(FILES)) writeFileSync(join(BASE, name), content);
});
afterAll(() => rmSync(BASE, { recursive: true, force: true }));

describe('collectSvelteFiles — devOnly', () => {
  it('skips test / __tests__ / stories `.svelte` files by default', () => {
    const found = collectSvelteFiles(BASE);
    expect(found).toContain(join(BASE, 'Foo.svelte'));
    expect(found).toContain(join(BASE, 'Button.svelte'));
    expect(found).not.toContain(join(BASE, 'Foo.test.svelte'));
    expect(found).not.toContain(join(BASE, 'Foo.stories.svelte'));
    expect(found).not.toContain(join(BASE, '__tests__', 'Fixture.svelte'));
  });

  it('counts them when disabled with `devOnly: []`', () => {
    const found = collectSvelteFiles(BASE, compileDevOnly(BASE, []));
    expect(found).toContain(join(BASE, 'Foo.test.svelte'));
    expect(found).toContain(join(BASE, 'Foo.stories.svelte'));
    expect(found).toContain(join(BASE, '__tests__', 'Fixture.svelte'));
  });

  it('honors a custom pattern set (replaces the default)', () => {
    // Only stories are dev-only now, so the `.test.svelte` and `__tests__` files
    // come back — proving `devOnly` replaces the default rather than adding to it.
    const found = collectSvelteFiles(BASE, compileDevOnly(BASE, ['**/*.stories.*']));
    expect(found).not.toContain(join(BASE, 'Foo.stories.svelte'));
    expect(found).toContain(join(BASE, 'Foo.test.svelte'));
    expect(found).toContain(join(BASE, '__tests__', 'Fixture.svelte'));
  });
});

describe('computeEscapedComponents — devOnly', () => {
  const components = collectSvelteFiles(BASE, compileDevOnly(BASE, []));

  it('does not escape a component imported only from a dev-only `Button.test.ts`', async () => {
    const result = await computeEscapedComponents({
      entryDirs: [BASE],
      root: BASE,
      components,
      resolve: fsResolve,
      readFile: fsReadFile,
    });
    expect(result.escaped).not.toContain(join(BASE, 'Button.svelte'));
  });

  it('escapes it when `devOnly: []` lets the test module be scanned', async () => {
    const result = await computeEscapedComponents({
      entryDirs: [BASE],
      root: BASE,
      components,
      devOnly: compileDevOnly(BASE, []),
      resolve: fsResolve,
      readFile: fsReadFile,
    });
    expect(result.escaped).toContain(join(BASE, 'Button.svelte'));
  });
});

// Behavior-level (Vite plugin): a story file passing a different prop value only
// pessimizes the fold when it counts as a call site.  Under the default dev-only
// set the story is discounted, so `p` folds and its branch is removed; with
// `devOnly: []` the story is a call site passing `p={true}`, so `p` is kept and the
// branch survives.
const APP = join(dirname(fileURLToPath(import.meta.url)), '.shaker-tmp-dev-only-app');
const IF_MACHINERY = /\bif_block\b|\$\.if\(/;

const APP_FILES: Record<string, string> = {
  'main.ts':
    "import { mount } from 'svelte';\nimport App from './App.svelte';\nmount(App, { target: document.body });\n",
  'App.svelte': "<script>import Widget from './Widget.svelte';</script>\n\n<Widget />\n",
  'Widget.svelte':
    '<script>let { p = false } = $props();</script>\n\n{#if p}<span>P BRANCH</span>{/if}\n<span>base</span>\n',
  'Widget.stories.svelte':
    "<script>import Widget from './Widget.svelte';</script>\n\n<Widget p={true} />\n",
};

beforeAll(() => {
  rmSync(APP, { recursive: true, force: true });
  mkdirSync(APP, { recursive: true });
  for (const [name, content] of Object.entries(APP_FILES)) writeFileSync(join(APP, name), content);
});
afterAll(() => rmSync(APP, { recursive: true, force: true }));

async function bundle(root: string, pre: unknown[]): Promise<string> {
  const result = (await build({
    root,
    logLevel: 'silent',
    configFile: false,
    build: {
      write: false,
      minify: false,
      reportCompressedSize: false,
      target: 'esnext',
      rollupOptions: { input: join(root, 'main.ts') },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    plugins: [...pre, svelte({ compilerOptions: { runes: true } })] as any,
  })) as Rollup.RollupOutput;
  return result.output.map((c) => ('code' in c ? c.code : '')).join('\n');
}

describe('vite-plugin-svelte-shaker — `devOnly` option', () => {
  it('folds a prop a story passes when the story is dev-only by default', async () => {
    const code = await bundle(APP, [shaker({ entries: ['.'] })]);
    expect(code).not.toMatch(IF_MACHINERY);
    expect(code).not.toContain('P BRANCH');
  });

  it('keeps the prop when `devOnly: []` lets the story count as a call site', async () => {
    const code = await bundle(APP, [shaker({ entries: ['.'], devOnly: [] })]);
    expect(code).toMatch(IF_MACHINERY);
    expect(code).toContain('P BRANCH');
  });
});

// Soundness contract (docs §8.1.1): `devOnly` only removes a file as a SEED / ESCAPE
// source — it must NOT leak into the import crawl.  A shipping `App.svelte` statically
// imports `Card.test.svelte` (which matches the default `**/*.test.*`) and passes it a
// foldable constant.  Even though the dev-only file is not seeded, the crawl reaches it
// through App's import, so it is still analyzed AND shaken: its dead branch folds away.
// If a future change let the filter drop the file from the crawl, the shaker would emit
// no residual for it and Rollup would bundle its raw source, so `DEAD ARM` would
// reappear and this test would fail loudly.
const CRAWL = join(dirname(fileURLToPath(import.meta.url)), '.shaker-tmp-dev-only-crawl');

const CRAWL_FILES: Record<string, string> = {
  'main.ts':
    "import { mount } from 'svelte';\nimport App from './App.svelte';\nmount(App, { target: document.body });\n",
  'App.svelte': "<script>import Card from './Card.test.svelte';</script>\n\n<Card p={false} />\n",
  'Card.test.svelte':
    '<script>let { p = false } = $props();</script>\n\n{#if p}<span>DEAD ARM</span>{/if}\n<span>card base</span>\n',
};

beforeAll(() => {
  rmSync(CRAWL, { recursive: true, force: true });
  mkdirSync(CRAWL, { recursive: true });
  for (const [name, content] of Object.entries(CRAWL_FILES))
    writeFileSync(join(CRAWL, name), content);
});
afterAll(() => rmSync(CRAWL, { recursive: true, force: true }));

describe('vite-plugin-svelte-shaker — `devOnly` does not touch the import crawl', () => {
  it('a dev-only file the app imports is still crawled and shaken (only seeds/escape sources drop)', async () => {
    const code = await bundle(CRAWL, [shaker({ entries: ['.'] })]);
    // Crawled and bundled through App's import despite matching the default `**/*.test.*` …
    expect(code).toContain('card base');
    // … and shaken: the constant `p={false}` folded the branch away.
    expect(code).not.toContain('DEAD ARM');
    expect(code).not.toMatch(IF_MACHINERY);
  });
});
