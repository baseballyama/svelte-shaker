import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';

// Vitest runs test files concurrently across workers (forks OR threads), but
// every worker that renders shares this oracle's temp dir.  A shared path makes
// them race: one worker's `afterAll(cleanTmp)` can `rmSync` a `.js` artifact
// another worker is mid-`import()` (surfacing as `ENOENT realpath …`), or two
// workers' teardowns collide on the same `rmdir` (`ENOTEMPTY`).  Namespacing the
// dir per worker gives each its own space, so a worker only ever writes and
// cleans its OWN files.  `VITEST_WORKER_ID` is unique among live workers and
// covers both the thread and the fork pool (pid alone does not — threads share a
// pid); fall back to the pid when run outside Vitest.  Files run sequentially
// within a worker, so a worker never races its own dir.
const WORKER_ID = process.env['VITEST_WORKER_ID'] ?? String(process.pid);
const TMP = join(dirname(fileURLToPath(import.meta.url)), `.shaker-tmp-${WORKER_ID}`);

export function cleanTmp(): void {
  rmSync(TMP, { recursive: true, force: true });
}

/**
 * Server-render a standalone `.svelte` source with the given props and return
 * its observable HTML — framework hydration comments stripped and whitespace
 * normalized.  This is the soundness oracle: shaking must not change what a
 * user sees, even though it deliberately changes the framework-internal markers
 * (removing a dead `{#if}` removes its SSR anchor — that is expected).
 *
 * `siblings` writes extra plain modules (e.g. a `./keys.js` the component
 * statically imports) next to the compiled component so those imports resolve;
 * each key is the file name relative to the compiled output.
 */
export async function renderHtml(
  source: string,
  props: Record<string, unknown>,
  filename: string,
  siblings: Record<string, string> = {},
): Promise<string> {
  const { js } = compile(source, { generate: 'server', filename, dev: false });
  mkdirSync(TMP, { recursive: true });
  for (const [name, code] of Object.entries(siblings)) writeFileSync(join(TMP, name), code);
  const hash = createHash('sha1').update(source).update(filename).digest('hex').slice(0, 16);
  const file = join(TMP, `${hash}.js`);
  writeFileSync(file, js.code);
  const mod = await import(pathToFileURL(file).href);
  const out = render(mod.default, { props });
  return normalizeHtml(out.body ?? out.html ?? '');
}

export function normalizeHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '') // drop framework comments (incl. SSR anchors)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Server-render a component that imports OTHER `.svelte` components, returning
 * its observable HTML — the same oracle as {@link renderHtml}, extended to a
 * small component graph.  `entry` is the component to render; `deps` maps each
 * relative `./Child.svelte` specifier (as it appears in source) to that child's
 * `.svelte` source.  Each component is compiled to JS in a fresh temp dir and
 * its `.svelte` import specifiers are rewired to the compiled `.js`, so the
 * static imports resolve.  This lets the cascade fixture (App -> Mid -> Heavy)
 * be checked end-to-end without weakening the single-file oracle.
 */
export async function renderGraphHtml(
  entry: { specifier: string; source: string },
  deps: Record<string, string>,
  props: Record<string, unknown>,
): Promise<string> {
  mkdirSync(TMP, { recursive: true });
  const hash = createHash('sha1')
    .update(entry.source)
    .update(JSON.stringify(Object.entries(deps).sort()))
    .digest('hex')
    .slice(0, 16);
  const dir = join(TMP, `graph-${hash}`);
  mkdirSync(dir, { recursive: true });

  const all: Record<string, string> = {
    [entry.specifier]: entry.source,
    ...deps,
  };
  // Compile every component to a sibling `.js`, rewriting `./X.svelte` import
  // specifiers (and the dynamic `import()` target) to `./X.svelte.js`.
  for (const [specifier, source] of Object.entries(all)) {
    const name = specifier.replace(/^\.\//, '');
    const { js } = compile(source, {
      generate: 'server',
      filename: name,
      dev: false,
    });
    const rewired = js.code.replace(
      /(['"])(\.\/[^'"]+\.svelte)\1/g,
      (_m, q: string, spec: string) => `${q}${spec}.js${q}`,
    );
    writeFileSync(join(dir, `${name}.js`), rewired);
  }

  const entryName = entry.specifier.replace(/^\.\//, '');
  const mod = await import(pathToFileURL(join(dir, `${entryName}.js`)).href);
  const out = render(mod.default, { props });
  return normalizeHtml(out.body ?? out.html ?? '');
}

/** Compile only, to assert the shaken source is still valid Svelte. */
export function assertCompiles(source: string, filename: string): void {
  compile(source, { generate: 'client', filename, dev: false });
  compile(source, { generate: 'server', filename, dev: false });
}
