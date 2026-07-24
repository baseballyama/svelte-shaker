import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build, type Rollup } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { shaker } from '../src/vite';
import {
  collectSvelteFiles,
  compileExclude,
  computeEscapedComponents,
  fsReadFile,
  fsResolve,
} from '../src/scan';

// A tree whose real source lives at the root, next to a `build/` directory holding
// a stale, previously-generated copy (the SvelteKit adapter-static shape).  The
// `exclude` option must prune `build/` from BOTH scans — the `.svelte` seed scan
// AND the non-`.svelte` escape scan — exactly as `devOnly` prunes a test file.
const BASE = join(dirname(fileURLToPath(import.meta.url)), '.shaker-tmp-exclude');

const FILES: Record<string, string> = {
  'Button.svelte': '<script>let { p = false } = $props();</script>\n{#if p}<b>P</b>{/if}\n',
  // A build artifact that imports the component — if the escape scan reads it,
  // `Button.svelte` is marked escaped and can no longer fold.
  'build/legacy.js': "import Button from '../Button.svelte';\nmount(Button, {});\n",
  // A generated `.svelte` copy inside the output dir — must not be seeded.
  'build/Copy.svelte': '<p>copy</p>\n',
};

beforeAll(() => {
  rmSync(BASE, { recursive: true, force: true });
  mkdirSync(join(BASE, 'build'), { recursive: true });
  for (const [name, content] of Object.entries(FILES)) writeFileSync(join(BASE, name), content);
});
afterAll(() => rmSync(BASE, { recursive: true, force: true }));

describe('collectSvelteFiles — exclude', () => {
  it('walks a build-output tree by default (nothing excluded)', () => {
    const found = collectSvelteFiles(BASE);
    expect(found).toContain(join(BASE, 'Button.svelte'));
    expect(found).toContain(join(BASE, 'build', 'Copy.svelte'));
  });

  it('prunes the excluded directory subtree', () => {
    const found = collectSvelteFiles(BASE, undefined, compileExclude(BASE, ['build']));
    expect(found).toContain(join(BASE, 'Button.svelte'));
    expect(found).not.toContain(join(BASE, 'build', 'Copy.svelte'));
  });

  it('accepts an absolute exclude entry as well as a root-relative one', () => {
    const found = collectSvelteFiles(BASE, undefined, compileExclude(BASE, [join(BASE, 'build')]));
    expect(found).not.toContain(join(BASE, 'build', 'Copy.svelte'));
  });
});

describe('computeEscapedComponents — exclude', () => {
  it('escapes a component a build artifact imports when nothing is excluded', async () => {
    const result = await computeEscapedComponents({
      entryDirs: [BASE],
      root: BASE,
      components: collectSvelteFiles(BASE), // walk everything, matching the scan below
      resolve: fsResolve,
      readFile: fsReadFile,
    });
    expect(result.escaped).toContain(join(BASE, 'Button.svelte'));
  });

  it('does not escape it once `build/` is excluded from the scan', async () => {
    const exclude = compileExclude(BASE, ['build']);
    const result = await computeEscapedComponents({
      entryDirs: [BASE],
      root: BASE,
      components: collectSvelteFiles(BASE, undefined, exclude), // same exclude as the scan
      exclude,
      resolve: fsResolve,
      readFile: fsReadFile,
    });
    expect(result.escaped).not.toContain(join(BASE, 'Button.svelte'));
  });
});

// Behavior-level (Vite plugin): a stale `build/` copy passing a different prop value
// only pessimizes the fold when the escape scan reads it.  Under `exclude: ['build']`
// the artifact is pruned, so `p` is not forced to escape and its dead branch folds.
const APP = join(dirname(fileURLToPath(import.meta.url)), '.shaker-tmp-exclude-app');
const IF_MACHINERY = /\bif_block\b|\$\.if\(/;

const APP_FILES: Record<string, string> = {
  'main.ts':
    "import { mount } from 'svelte';\nimport App from './App.svelte';\nmount(App, { target: document.body });\n",
  'App.svelte': "<script>import Widget from './Widget.svelte';</script>\n\n<Widget />\n",
  'Widget.svelte':
    '<script>let { p = false } = $props();</script>\n\n{#if p}<span>P BRANCH</span>{/if}\n<span>base</span>\n',
  // A stale build artifact that mounts Widget — an escape source the scan would
  // otherwise read and use to bail Widget's props.
  'build/app.js': "import Widget from '../Widget.svelte';\nmount(Widget, {});\n",
};

beforeAll(() => {
  rmSync(APP, { recursive: true, force: true });
  mkdirSync(join(APP, 'build'), { recursive: true });
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
    plugins: [...pre, svelte({ compilerOptions: { runes: true } })] as any,
  })) as Rollup.RollupOutput;
  return result.output.map((c) => ('code' in c ? c.code : '')).join('\n');
}

describe('vite-plugin-svelte-shaker — `exclude` option', () => {
  it('keeps the prop when the stale build artifact is scanned (escape source)', async () => {
    const code = await bundle(APP, [shaker({ entries: ['.'] })]);
    expect(code).toMatch(IF_MACHINERY);
    expect(code).toContain('P BRANCH');
  });

  it('folds the prop once `build/` is excluded', async () => {
    const code = await bundle(APP, [shaker({ entries: ['.'], exclude: ['build'] })]);
    expect(code).not.toMatch(IF_MACHINERY);
    expect(code).not.toContain('P BRANCH');
  });
});

// Guard (docs §8.1.1): the automatic `build.outDir` exclusion must NOT prune real
// source.  A misconfigured `outDir` that is the crawl root (or an ancestor of an
// entry dir) would do exactly that, so the plugin skips the auto-exclusion and
// warns.  This fixture has NO escape source and never passes `p`, so a correct
// build folds the branch away — proving the source was still crawled, not pruned.
const GUARD = join(dirname(fileURLToPath(import.meta.url)), '.shaker-tmp-exclude-guard');

const GUARD_FILES: Record<string, string> = {
  'main.ts':
    "import { mount } from 'svelte';\nimport App from './App.svelte';\nmount(App, { target: document.body });\n",
  'App.svelte': "<script>import Widget from './Widget.svelte';</script>\n\n<Widget />\n",
  'Widget.svelte':
    '<script>let { p = false } = $props();</script>\n\n{#if p}<span>P BRANCH</span>{/if}\n<span>base</span>\n',
};

beforeAll(() => {
  rmSync(GUARD, { recursive: true, force: true });
  mkdirSync(GUARD, { recursive: true });
  for (const [name, content] of Object.entries(GUARD_FILES))
    writeFileSync(join(GUARD, name), content);
});
afterAll(() => rmSync(GUARD, { recursive: true, force: true }));

async function bundleWithOutDir(
  root: string,
  outDir: string,
): Promise<{ code: string; warnings: string[] }> {
  const warnings: string[] = [];
  const result = (await build({
    root,
    configFile: false,
    customLogger: {
      info() {},
      warn: (msg) => warnings.push(msg),
      warnOnce() {},
      error() {},
      clearScreen() {},
      hasErrorLogged: () => false,
      hasWarned: false,
    },
    build: {
      outDir,
      write: false,
      minify: false,
      reportCompressedSize: false,
      target: 'esnext',
      rollupOptions: { input: join(root, 'main.ts') },
    },
    plugins: [shaker({ entries: ['.'] }), svelte({ compilerOptions: { runes: true } })] as any,
  })) as Rollup.RollupOutput;
  const code = result.output.map((c) => ('code' in c ? c.code : '')).join('\n');
  return { code, warnings };
}

describe('vite-plugin-svelte-shaker — build.outDir auto-exclusion guard', () => {
  it('does not exclude when outDir is the crawl root (source is still crawled and shaken)', async () => {
    const { code, warnings } = await bundleWithOutDir(GUARD, '.');
    // The branch folded away -> Widget WAS crawled (source not pruned by outDir='.').
    expect(code).not.toMatch(IF_MACHINERY);
    expect(code).not.toContain('P BRANCH');
    // And the skip is surfaced, naming build.outDir.
    expect(warnings.some((w) => w.includes('build.outDir'))).toBe(true);
  });
});
