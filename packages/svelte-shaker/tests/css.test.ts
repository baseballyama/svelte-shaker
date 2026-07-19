import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build, type Rollup } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { shaker } from '../src/vite';
import { svelteShaker } from '../src/index';
import { fsResolve } from '../src/scan';
import { analyze } from '../src/analyze';
import { computePossibleClasses } from '../src/css';
import { assertCompiles, cleanTmp, renderHtml } from './diff';

// ----------------------------------------------------------------------
// CSS rule removal (docs §3 "value-set narrowing", "CSS (shaker 独自の価値)").
//
// The headline differentiator: Svelte's own unused-CSS pruning keeps
// `.btn-danger` for an interpolated `class="btn btn-{variant}"` because it cannot
// prove `variant ∈ {primary,secondary}`; rollup cannot either.  The build bench
// below proves the toolchain CANNOT shake it (control keeps `btn-danger`) while
// the shaker CAN (shaken drops `btn-danger`/`btn-ghost`, keeps the rest).
// ----------------------------------------------------------------------

// Build inside the package so the temp app resolves `svelte/internal/*`.
const APP = join(dirname(fileURLToPath(import.meta.url)), '.shaker-tmp-css');

const FILES: Record<string, string> = {
  'main.ts': `import { mount } from 'svelte';\nimport App from './App.svelte';\nmount(App, { target: document.body });\n`,
  // App passes variant="primary" and variant="secondary" at two call sites.
  'App.svelte': `<script lang="ts">\n  import Btn from './Btn.svelte';\n</script>\n\n<Btn variant="primary" />\n<Btn variant="secondary" />\n`,
  // Btn interpolates the variant into the class; only primary/secondary occur.
  'Btn.svelte': `<script lang="ts">\n  let { variant }: { variant: 'primary' | 'secondary' | 'danger' | 'ghost' } = $props();\n</script>\n\n<button class="btn btn-{variant}">{variant}</button>\n\n<style>\n  .btn { font: inherit }\n  .btn-primary { color: green }\n  .btn-secondary { color: teal }\n  .btn-danger { color: red }\n  .btn-ghost { background: transparent }\n</style>\n`,
};

beforeAll(() => {
  rmSync(APP, { recursive: true, force: true });
  mkdirSync(APP, { recursive: true });
  for (const [name, content] of Object.entries(FILES)) writeFileSync(join(APP, name), content);
});

afterAll(() => {
  rmSync(APP, { recursive: true, force: true });
  // `renderHtml` (the soundness oracle) also writes into this worker's own
  // `.shaker-tmp-*` dir; clean it here too so this file's render artifacts are
  // not orphaned when it is the only suite running in its worker.
  cleanTmp();
});

/** Concatenated source of every emitted `.css` asset (Svelte extracts CSS). */
async function bundleCss(pre: unknown[]): Promise<string> {
  const result = (await build({
    root: APP,
    logLevel: 'silent',
    configFile: false,
    build: {
      write: false,
      minify: false,
      reportCompressedSize: false,
      target: 'esnext',
      rollupOptions: { input: join(APP, 'main.ts') },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    plugins: [...pre, svelte({ compilerOptions: { runes: true } })] as any,
  })) as Rollup.RollupOutput;
  return result.output
    .filter((c) => c.type === 'asset' && c.fileName.endsWith('.css'))
    .map((c) => (c.type === 'asset' ? String(c.source) : ''))
    .join('\n');
}

describe('vite-plugin-svelte-shaker / CSS rule removal (end-to-end build)', () => {
  it('control: Svelte keeps `.btn-danger` (the toolchain cannot shake it)', async () => {
    const css = await bundleCss([]);
    // Svelte conservatively keeps every interpolated-class rule.
    expect(css).toContain('btn-danger');
    expect(css).toContain('btn-ghost');
    expect(css).toContain('btn-primary');
    expect(css).toContain('btn-secondary');
  });

  it('shaker: `.btn-danger`/`.btn-ghost` are removed, `.btn`/primary/secondary kept', async () => {
    const css = await bundleCss([shaker({ include: ['.'] })]);
    // We proved variant ∈ {primary,secondary}, so danger/ghost can never exist.
    expect(css).not.toContain('btn-danger');
    expect(css).not.toContain('btn-ghost');
    // The classes that CAN occur are still styled.
    expect(css).toContain('btn-primary');
    expect(css).toContain('btn-secondary');
    expect(css).toMatch(/\.btn\b/); // the base `.btn` rule survives
  });
});

// ----------------------------------------------------------------------
// Standalone engine test: a Btn shaken in isolation drops `.btn-danger` (and the
// other unreachable rules) and keeps the rest, and the result still compiles.
// ----------------------------------------------------------------------

describe('svelte-shaker / CSS rule removal (engine)', () => {
  const readFile = (id: string) => readFileSync(id, 'utf-8');
  const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'css-variant');

  it('possible class set is bounded and excludes danger/ghost', async () => {
    const entry = join(FIXTURE, 'input', 'App.svelte');
    const { models, plans } = await analyze(entry, fsResolve, readFile);
    const btnId = join(FIXTURE, 'input', 'Btn.svelte');
    const model = models.get(btnId)!;
    const plan = plans.get(btnId)!;

    // The narrowed value set is what makes the class set enumerable.
    expect([...(plan.narrow.get('variant') ?? [])].sort()).toEqual(['primary', 'secondary']);

    const possible = computePossibleClasses(model, plan);
    expect(possible.unbounded).toBe(false);
    expect([...possible.classes].sort()).toEqual(['btn', 'btn-primary', 'btn-secondary']);
  });

  it('drops only the unreachable rules and the result still compiles', async () => {
    const entry = join(FIXTURE, 'input', 'App.svelte');
    const out = await svelteShaker(entry, fsResolve, readFile);
    const shaken = out[join(FIXTURE, 'input', 'Btn.svelte')]!;

    // Removed: the classes no element can ever carry.
    expect(shaken).not.toContain('.btn-danger');
    expect(shaken).not.toContain('.btn-ghost');
    // Kept: the reachable classes, the bare element rule, and a `.btn` pseudo.
    expect(shaken).toContain('.btn-primary');
    expect(shaken).toContain('.btn-secondary');
    expect(shaken).toMatch(/\.btn\s*\{/);
    expect(shaken).toContain('button {'); // element-only rule never removed
    expect(shaken).toContain('.btn:hover'); // `.btn` is present -> kept

    // The slimmed source is still valid Svelte (client + server compile).
    assertCompiles(shaken, 'Btn.svelte');
  });

  it('soundness: the rendered HTML is identical for every occurring variant', async () => {
    // Removing a rule whose class can never exist cannot change styling for any
    // element that actually occurs.  The HTML the user sees is unchanged for both
    // values that this app passes.
    const entry = join(FIXTURE, 'input', 'App.svelte');
    const original = readFileSync(join(FIXTURE, 'input', 'Btn.svelte'), 'utf-8');
    const out = await svelteShaker(entry, fsResolve, readFile);
    const shaken = out[join(FIXTURE, 'input', 'Btn.svelte')]!;

    for (const variant of ['primary', 'secondary'] as const) {
      const before = await renderHtml(original, { variant }, 'Btn.svelte');
      const after = await renderHtml(shaken, { variant }, 'Btn.svelte');
      expect(after, variant).toBe(before);
    }
  });

  it('keeps every rule when a class source is unbounded (sound bail)', async () => {
    // A genuinely dynamic `class={cls}` makes the class set unbounded, so NO rule
    // may be removed — even though `variant` is still narrowable.
    const dir = join(APP, '..', '.shaker-tmp-css-unbounded');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'App.svelte'),
      `<script lang="ts">\n  import Btn from './Btn.svelte';\n  let cls = 'x';\n</script>\n<Btn variant="primary" cls={cls} />\n<Btn variant="secondary" cls={cls} />\n`,
    );
    writeFileSync(
      join(dir, 'Btn.svelte'),
      `<script lang="ts">\n  let { variant, cls }: { variant: 'primary' | 'secondary'; cls: string } = $props();\n</script>\n<button class="btn btn-{variant}">x</button>\n<span class={cls}>y</span>\n<style>\n  .btn { color: blue }\n  .btn-danger { color: red }\n  .btn-primary { color: green }\n</style>\n`,
    );
    const out = await svelteShaker(join(dir, 'App.svelte'), fsResolve, readFile);
    const shaken = out[join(dir, 'Btn.svelte')]!;
    // `cls` is dynamic -> unbounded -> nothing removed, danger survives.
    expect(shaken).toContain('.btn-danger');
    expect(shaken).toContain('.btn-primary');
    assertCompiles(shaken, 'Btn.svelte');
    rmSync(dir, { recursive: true, force: true });
  });
});
