import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build, type Plugin, type Rollup } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { shaker } from '../src/vite';
import { tryLoadNativeEngine } from '../src/native-engine';

// Issue #203: a component whose resolved id is not a file on disk — a `\0`-prefixed
// virtual id, or a path-shaped id another plugin's `load` hook supplies — has a
// source the shaker cannot read, so whatever it renders is an invisible call site.
const BASE = join(dirname(fileURLToPath(import.meta.url)), '.shaker-tmp-virtual');
const nativeAvailable = tryLoadNativeEngine() !== null;
const IF_MACHINERY = /\bif_block\b|\$\.if\(/;

const SUB = [
  '<script lang="ts">',
  '  let { hasIcon }: { hasIcon: boolean } = $props();',
  '</script>',
  '',
  '{#if hasIcon}<p>ICON BRANCH</p>{/if}',
  '<p>base</p>',
].join('\n');

function writeApp(dir: string, content: Record<string, string>): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(content)) writeFileSync(join(dir, name), body);
}

afterAll(() => rmSync(BASE, { recursive: true, force: true }));

/** The hook context `buildStart` needs: a `this.resolve` that maps `virtual:child` to `id`. */
function hookContext(id: string) {
  return {
    resolve: async (source: string) =>
      source === 'virtual:child' ? { id, external: false } : null,
  };
}

type Hook = (this: unknown, ...args: unknown[]) => unknown;

describe('vite-plugin-svelte-shaker — virtual component ids (#203)', () => {
  const engines = [
    { engine: 'js' as const, skip: false },
    { engine: 'rust' as const, skip: !nativeAvailable },
  ];
  const ids = {
    'null-prefixed': () => '\0virtual-child.svelte',
    'path-shaped': (root: string) => join(root, '__virtual__/Child.svelte'),
  };

  for (const { engine, skip } of engines) {
    for (const [kind, makeId] of Object.entries(ids)) {
      it.skipIf(skip)(
        `${engine} engine: a ${kind} virtual child does not crash, and the shake bails with a warning`,
        async () => {
          const root = join(BASE, `hook-${engine}-${kind}`);
          const app = '<script>import Child from "virtual:child";</script><Child/>';
          writeApp(root, { 'App.svelte': app });
          const warnings: string[] = [];
          const logger = { info: () => {}, warn: (msg: string) => warnings.push(msg) };
          const plugin = shaker({ entries: ['.'], monomorphize: false, engine });
          (plugin.configResolved as Hook)({ root, build: { outDir: 'dist' }, logger });
          const id = makeId(root);

          await (plugin.buildStart as Hook).call(hookContext(id));

          expect(warnings).toHaveLength(1);
          expect(warnings[0]).toContain(
            kind === 'null-prefixed' ? '\\0virtual-child.svelte' : '__virtual__',
          );
          const appId = join(root, 'App.svelte');
          expect((plugin.transform as Hook).call({}, readFileSync(appId, 'utf-8'), appId)).toBe(
            null,
          );
        },
      );
    }
  }

  // A virtual PARENT: `Wrapper.svelte` exists only in a plugin's `load` hook and
  // renders the real `Sub` with `hasIcon={true}`.  The only call site the crawl can
  // read passes `hasIcon={false}`, so folding on it would delete the branch the
  // virtual parent needs.  The shake must not ship that.
  describe('a virtual parent that renders a real component', () => {
    const dir = join(BASE, 'parent');
    const wrapperId = join(dir, '__virtual__', 'Wrapper.svelte');
    const virtualParent = (): Plugin => ({
      name: 'virtual-parent',
      enforce: 'pre',
      resolveId(source) {
        return source === 'virtual:wrapper' ? wrapperId : null;
      },
      load(id) {
        if (id !== wrapperId) return null;
        return `<script>\n  import Sub from '${join(dir, 'Sub.svelte')}';\n</script>\n\n<Sub hasIcon={true} />\n`;
      },
    });

    beforeAll(() =>
      writeApp(dir, {
        'main.ts': [
          "import { mount } from 'svelte';",
          "import App from './App.svelte';",
          'mount(App, { target: document.body });',
        ].join('\n'),
        'App.svelte': [
          '<script>',
          "  import Sub from './Sub.svelte';",
          "  import Wrapper from 'virtual:wrapper';",
          '</script>',
          '',
          '<Sub hasIcon={false} />',
          '<Wrapper />',
        ].join('\n'),
        'Sub.svelte': `${SUB}\n`,
      }),
    );

    async function bundle(pre: unknown[]): Promise<string> {
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
        plugins: [...pre, virtualParent(), svelte({ compilerOptions: { runes: true } })] as any,
      })) as Rollup.RollupOutput;
      return result.output.map((c) => ('code' in c ? c.code : '')).join('\n');
    }

    for (const { engine, skip } of engines) {
      it.skipIf(skip)(
        `${engine} engine: keeps the branch only the virtual parent reaches`,
        async () => {
          const code = await bundle([shaker({ entries: ['.'], engine })]);
          expect(code).toContain('ICON BRANCH');
          expect(code).toMatch(IF_MACHINERY);
        },
      );
    }
  });

  // Control: a virtual NON-component module (the `$env/static/public` shape) that a
  // `.ts` module imports is an ordinary dependency, not an invisible call site, so
  // it must not cost the app its shake.
  it('a virtual non-component module imported from `.ts` does not disable the shake', async () => {
    const dir = join(BASE, 'env');
    writeApp(dir, {
      'main.ts': [
        "import { mount } from 'svelte';",
        "import { flag } from 'virtual:env';",
        "import App from './App.svelte';",
        'mount(App, { target: document.body, props: { flag } });',
      ].join('\n'),
      'App.svelte': `<script>\n  import Sub from './Sub.svelte';\n</script>\n\n<Sub hasIcon={false} />\n`,
      'Sub.svelte': `${SUB}\n`,
    });
    const virtualEnv: Plugin = {
      name: 'virtual-env',
      resolveId: (source) => (source === 'virtual:env' ? '\0virtual:env' : null),
      load: (id) => (id === '\0virtual:env' ? 'export const flag = true;' : null),
    };
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
      plugins: [
        shaker({ entries: ['.'] }),
        virtualEnv,
        svelte({ compilerOptions: { runes: true } }),
      ] as any,
    })) as Rollup.RollupOutput;
    const code = result.output.map((c) => ('code' in c ? c.code : '')).join('\n');
    expect(code).not.toContain('ICON BRANCH');
  });
});
