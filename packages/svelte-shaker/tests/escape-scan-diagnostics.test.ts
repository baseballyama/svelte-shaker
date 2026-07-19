import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build, type Logger } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { shaker } from '../src/vite';
import { computeEscapedComponents } from '../src/escape-scan';
import { collectSvelteFiles, fsReadFile, fsResolve } from '../src/scan';

const BASE = join(dirname(fileURLToPath(import.meta.url)), '.shaker-tmp-diag');

// A `.tsx` whose BODY is JSX: the `<script module lang="ts">` wrapper the scan uses
// parses TS but NOT JSX, so this module fails to parse — the scan must report it,
// not silently drop the call site it could hide.
const BROKEN_TSX = 'export const C = <div class="x">hi</div>;\n';
const GOOD_TS = "import W from './Widget.svelte';\nexport const w = W;\n"; // imports Widget
const WIDGET = '<script>let { p = false } = $props();</script>\n{#if p}<span>P</span>{/if}\n';

beforeAll(() => {
  rmSync(BASE, { recursive: true, force: true });
  mkdirSync(BASE, { recursive: true });
  writeFileSync(join(BASE, 'broken.tsx'), BROKEN_TSX);
  writeFileSync(join(BASE, 'good.ts'), GOOD_TS);
  writeFileSync(join(BASE, 'Widget.svelte'), WIDGET);
  writeFileSync(join(BASE, 'Other.svelte'), '<p>other</p>\n');
  writeFileSync(join(BASE, 'main.ts'), "import W from './Widget.svelte';\nexport { W };\n");
});
afterAll(() => rmSync(BASE, { recursive: true, force: true }));

describe('computeEscapedComponents — structured diagnostics', () => {
  it('reports an unparseable module in `unscannable` while still escaping a good one', async () => {
    const components = collectSvelteFiles(BASE);
    const result = await computeEscapedComponents({
      includeDirs: [BASE],
      root: BASE,
      components,
      resolve: fsResolve,
      readFile: fsReadFile,
    });
    // good.ts imports Widget → escaped; broken.tsx failed to parse → reported.
    expect(result.escaped).toContain(join(BASE, 'Widget.svelte'));
    expect(result.unscannable).toContain(join(BASE, 'broken.tsx'));
    expect(result.escaped).not.toContain(join(BASE, 'broken.tsx'));
  });

  it('reports an `external` entry that matches nothing (and stays quiet for a hit)', async () => {
    const components = collectSvelteFiles(BASE);
    const miss = await computeEscapedComponents({
      includeDirs: [BASE],
      root: BASE,
      external: ['./DoesNotExist.svelte'],
      components,
      resolve: fsResolve,
      readFile: fsReadFile,
    });
    expect(miss.unmatchedExternal).toEqual(['./DoesNotExist.svelte']);

    const hit = await computeEscapedComponents({
      includeDirs: [BASE],
      root: BASE,
      external: ['./Other.svelte'],
      components,
      resolve: fsResolve,
      readFile: fsReadFile,
    });
    expect(hit.unmatchedExternal).toEqual([]);
    expect(hit.escaped).toContain(join(BASE, 'Other.svelte'));
  });
});

/** A Vite logger that records `warn` messages so we can assert the plugin surfaces
 * the scan diagnostics. Only `warn` matters; the rest are no-op stubs. */
function recordingLogger(warnings: string[]): Logger {
  const noop = (): void => {};
  return {
    info: noop,
    warn: (msg: string) => warnings.push(msg),
    warnOnce: (msg: string) => warnings.push(msg),
    error: noop,
    clearScreen: noop,
    hasErrorLogged: () => false,
    hasWarned: false,
  };
}

async function bundleWith(warnings: string[], pre: unknown[]): Promise<void> {
  await build({
    root: BASE,
    logLevel: 'silent',
    configFile: false,
    customLogger: recordingLogger(warnings),
    build: {
      write: false,
      minify: false,
      reportCompressedSize: false,
      target: 'esnext',
      // broken.tsx just sits on disk for the FS scan to hit; main.ts is the entry.
      rollupOptions: { input: join(BASE, 'main.ts') },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    plugins: [...pre, svelte({ compilerOptions: { runes: true } })] as any,
  }).catch(() => {
    // A missing rollup input entry can still error; the warnings we assert on are
    // emitted in `buildStart` before that, so ignore the build outcome here.
  });
}

describe('vite-plugin-svelte-shaker — scan warnings', () => {
  it('warns (with the file path) about a module the scan cannot parse', async () => {
    const warnings: string[] = [];
    await bundleWith(warnings, [shaker({ include: ['.'] })]);
    const w = warnings.find((m) => m.includes('could not parse'));
    expect(w, warnings.join('\n')).toBeDefined();
    expect(w).toContain('broken.tsx');
    expect(w).toContain('external');
  });

  it('warns about an `external` entry that matched no component', async () => {
    const warnings: string[] = [];
    await bundleWith(warnings, [shaker({ include: ['.'], external: ['./Nope.svelte'] })]);
    const w = warnings.find((m) => m.includes('matched no component'));
    expect(w, warnings.join('\n')).toBeDefined();
    expect(w).toContain('./Nope.svelte');
  });
});
