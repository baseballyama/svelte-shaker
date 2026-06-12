import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { shaker } from 'svelte-shaker/vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'vite';

// The e2e package root is one level above this test file.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const TMP = join(HERE, '.e2e-tmp');

// Locate mode-watcher's compiled .svelte components.  pnpm always places a
// direct dependency in the package's own node_modules (via the virtual store),
// so the path below is stable.  We cannot use require.resolve('mode-watcher/…')
// because mode-watcher's exports map does not include `./package.json` or any
// non-`svelte`-conditioned entry.  `collectSvelteFiles` skips dirs NAMED
// `node_modules`, but will scan an explicit absolute path inside one fine.
const modeWatcherComponents = join(ROOT, 'node_modules', 'mode-watcher', 'dist', 'components');

// Shaker include list: the full app src plus mode-watcher's own .svelte
// components.  Without the latter, the shaker never sees ModeWatcher.svelte's
// call sites and cannot fold its never-passed props — the #37 bug would be
// silently skipped instead of caught.
const SHAKER_INCLUDE = [join(ROOT, 'src'), modeWatcherComponents];

interface RenderBundle {
  render: () => { head: string; body: string };
}

/**
 * Run a Vite SSR build of `src/entry-server.ts` into `outDir`.
 * `withShaker` controls whether svelte-shaker is in the plugin chain.
 */
async function buildSsr(outDir: string, withShaker: boolean): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plugins: any[] = withShaker ? [shaker({ include: SHAKER_INCLUDE }), svelte()] : [svelte()];

  await build({
    root: ROOT,
    logLevel: 'silent',
    configFile: false,
    build: {
      ssr: true,
      outDir,
      minify: false,
      target: 'node22',
      rollupOptions: {
        input: join(ROOT, 'src/entry-server.ts'),
        output: { format: 'es', entryFileNames: '[name].js' },
      },
    },
    plugins,
  });
}

/** Import a built SSR bundle from `outDir` and return its exports. */
async function importBundle(outDir: string): Promise<RenderBundle> {
  const url = pathToFileURL(join(outDir, 'entry-server.js')).href;
  return (await import(url)) as RenderBundle;
}

/**
 * Normalise SSR HTML for comparison: strip framework hydration comments and
 * collapse whitespace so cosmetic differences don't mask real ones.
 */
function normalise(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── test suite ────────────────────────────────────────────────────────────

beforeAll(() => {
  // Start each run with a clean slate to avoid stale build artefacts.
  rmSync(TMP, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('no-shaker baseline', () => {
  const outDir = join(TMP, 'control');

  it('SSR build succeeds without the shaker', async () => {
    await buildSsr(outDir, false);
  });

  it('render() returns non-empty HTML', async () => {
    const { render } = await importBundle(outDir);
    const { body } = render();
    expect(typeof body).toBe('string');
    expect(body.length).toBeGreaterThan(0);
    // Spot-check that a few pattern markers survived compilation.
    expect(body).toContain('normal mode'); // ShorthandFold — falsy branch
    expect(body).toContain('aliased-default'); // AliasedProp
    expect(body).toContain('rest-props content'); // RestProps
    expect(body).toContain('e2e test'); // TypedProps title
  });
});

describe('differential SSR oracle', () => {
  // The current engine has the #37 aliased-prop bug.  The shaken render()
  // will either throw a ReferenceError (modeStorageKeyProp is not defined)
  // or produce HTML that differs from the control.  Either outcome is caught
  // by this test.  DO NOT weaken, skip, or special-case these assertions —
  // a passing differential test here means the bug is fixed.
  const controlDir = join(TMP, 'control');
  const shakenDir = join(TMP, 'shaken');

  it('shaker SSR build succeeds', async () => {
    await buildSsr(shakenDir, true);
  });

  it('shaken render() HTML matches control (catches over-shaking bugs like #37)', async () => {
    const control = await importBundle(controlDir);
    const shaken = await importBundle(shakenDir);

    const controlResult = control.render();
    const shakenResult = shaken.render();

    expect(normalise(shakenResult.head)).toBe(normalise(controlResult.head));
    expect(normalise(shakenResult.body)).toBe(normalise(controlResult.body));
  });
});

describe('client build smoke test', () => {
  it('vite build (client) with shaker succeeds', async () => {
    const outDir = join(TMP, 'client');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await build({
      root: ROOT,
      logLevel: 'silent',
      configFile: false,
      build: {
        outDir,
        minify: false,
        rollupOptions: { input: join(ROOT, 'src/main.ts') },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      plugins: [shaker({ include: SHAKER_INCLUDE }), svelte()] as any[],
    });
  });
});
