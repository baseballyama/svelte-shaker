import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { shaker } from '../src/vite';
import type { DevMode } from '../src/engine';

// Run inside the package so the temp app resolves `svelte/internal/*`.
const APP = join(dirname(fileURLToPath(import.meta.url)), '.shaker-tmp-dev-vite');

/** Conditional-rendering machinery Svelte emits for a surviving `{#if}`. */
const IF_MACHINERY = /\bif_block\b|\$\.if\(/;

const FILES: Record<string, string> = {
  'App.svelte': `<script lang="ts">\n  import Sub from './Sub.svelte';\n</script>\n\n<Sub hasIcon={false} />\n`,
  'Sub.svelte': `<script lang="ts">\n  let { hasIcon }: { hasIcon: boolean } = $props();\n</script>\n\n{#if hasIcon}\n  <p>Icon</p>\n{/if}\n\n<p>This is Sub Component</p>\n`,
};

let server: ViteDevServer | undefined;

beforeEach(() => {
  rmSync(APP, { recursive: true, force: true });
  mkdirSync(APP, { recursive: true });
  for (const [name, content] of Object.entries(FILES)) writeFileSync(join(APP, name), content);
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  rmSync(APP, { recursive: true, force: true });
});

async function startServer(dev: false | DevMode): Promise<ViteDevServer> {
  server = await createServer({
    root: APP,
    logLevel: 'silent',
    configFile: false,
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    plugins: [shaker({ entries: ['.'], dev }), svelte({ compilerOptions: { runes: true } })] as any,
  });
  return server;
}

/** The compiled JS vite-plugin-svelte serves for a `.svelte` request in dev. */
async function compiled(s: ViteDevServer, url: string): Promise<string> {
  const result = await s.transformRequest(url);
  return result?.code ?? '';
}

describe('vite-plugin-svelte-shaker (dev server)', () => {
  it('dev: false — pass-through: the dead `{#if}` still compiles to machinery', async () => {
    const s = await startServer(false);
    const code = await compiled(s, '/Sub.svelte');
    expect(code).toMatch(IF_MACHINERY);
    expect(code).toContain('This is Sub Component');
  });

  it("dev: 'incremental' — shakes in serve: the dead branch is gone", async () => {
    const s = await startServer('incremental');
    const code = await compiled(s, '/Sub.svelte');
    expect(code).not.toMatch(IF_MACHINERY); // `hasIcon={false}` folded -> no `{#if}`
    expect(code).toContain('This is Sub Component');
  });

  it('HMR widening: editing App rewrites the un-edited child Sub', async () => {
    const sh = shaker({ entries: ['.'], dev: 'incremental' });
    server = await createServer({
      root: APP,
      logLevel: 'silent',
      configFile: false,
      server: { middlewareMode: true, hmr: false, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      plugins: [sh, svelte({ compilerOptions: { runes: true } })] as any,
    });
    const s = server;

    // Warm the module graph and confirm the initial shake (Icon folded away).
    await compiled(s, '/App.svelte');
    expect(await compiled(s, '/Sub.svelte')).not.toContain('Icon');

    // Edit the CALL SITE: App now passes `hasIcon={true}`.  Sub is untouched on
    // disk, but its residual must change (Icon kept) — the HMR divergence.
    const appPath = join(APP, 'App.svelte');
    const subPath = join(APP, 'Sub.svelte');
    writeFileSync(appPath, FILES['App.svelte']!.replace('hasIcon={false}', 'hasIcon={true}'));

    const ctx = {
      file: appPath,
      timestamp: 1,
      modules: [...(s.moduleGraph.getModulesByFile(appPath) ?? [])],
      read: async () => readFileSync(appPath, 'utf-8'),
      server: s,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const widened = (await (sh as any).handleHotUpdate(ctx)) as Array<{ file?: string | null }>;

    // The widened HMR set must include Sub — the child whose output changed even
    // though App was the edited file.
    expect(widened.some((m) => m.file === subPath)).toBe(true);

    // And re-requesting Sub now serves the re-shaken output: Icon is kept.
    expect(await compiled(s, '/Sub.svelte')).toContain('Icon');
  });
});
