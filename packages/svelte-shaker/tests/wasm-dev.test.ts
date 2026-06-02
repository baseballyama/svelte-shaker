import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { buildAnalyzeInput, svelteShaker, type ReadFile, type Resolve } from '../src/index';
import { parseSvelte, type Root } from '../src/parse';
import { assertCompiles, cleanTmp } from './diff';

afterAll(() => cleanTmp());

// ----------------------------------------------------------------------
// M6 (docs/RUST-MIGRATION.md M6): the dev incremental flow on the Rust engine.
// A tiny incremental driver mirrors what `vite dev` does — it keeps a content-
// keyed parse cache (re-parsing ONLY changed files) and re-shakes via the Rust
// WASM `shake_program` on each change.  After every edit/add/remove we assert the
// Rust-driven output is byte-identical to a from-scratch TS `svelteShaker` of the
// current file set.  So the whole-program cascade under a CHANGING file set
// (un-shake on a new caller, re-shake on removal) is correct on the Rust engine.
// ----------------------------------------------------------------------

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports
const wasm = require('../engine-rs/pkg/svelte_shaker_engine.js') as {
  shake_program: (inputJson: string) => string;
};

/** A minimal Rust-engine dev shaker: parse-cache (only changed files re-parse) +
 * `shake_program` over the current file set. */
class RustDevShaker {
  private readonly parseCache = new Map<string, { code: string; ast: Root }>();
  constructor(
    private readonly resolve: Resolve,
    private readonly readFile: ReadFile,
  ) {}

  private parse(id: string, code: string): Root {
    const hit = this.parseCache.get(id);
    if (hit && hit.code === code) return hit.ast;
    const ast = parseSvelte(code, id);
    this.parseCache.set(id, { code, ast });
    return ast;
  }

  async shake(entries: string[]): Promise<Record<string, string>> {
    const input = await buildAnalyzeInput(entries, this.resolve, this.readFile);
    const programInput = {
      // The parse cache means an unchanged file is not re-parsed across edits.
      files: input.files.map((f) => ({ id: f.id, ast: this.parse(f.id, f.code), code: f.code })),
      edges: input.edges,
      entries: input.entries,
    };
    return JSON.parse(wasm.shake_program(JSON.stringify(programInput)));
  }
}

function mutableGraph(initial: Record<string, string>): {
  files: Record<string, string>;
  resolve: Resolve;
  readFile: ReadFile;
  svelteIds: () => string[];
} {
  const files = { ...initial };
  const resolve: Resolve = (source, importer) => {
    if (!source.startsWith('.')) return null;
    const base = importer.slice(0, importer.lastIndexOf('/'));
    const parts: string[] = [];
    for (const seg of `${base}/${source}`.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    return `/${parts.join('/')}`;
  };
  const readFile: ReadFile = (id) => {
    const code = files[id];
    if (code === undefined) throw new Error(`no such file: ${id}`);
    return code;
  };
  return {
    files,
    resolve,
    readFile,
    svelteIds: () => Object.keys(files).filter((f) => f.endsWith('.svelte')),
  };
}

const APP_NO_ICON = `<script>\n  import Sub from './Sub.svelte';\n</script>\n<Sub />`;
const APP_ICON = `<script>\n  import Sub from './Sub.svelte';\n</script>\n<Sub hasIcon={true} />`;
const APP_NO_SUB = `<script>\n  import Sub from './Sub.svelte';\n</script>\n<p>hi</p>`;
const SUB = `<script>\n  let { hasIcon = false } = $props();\n</script>\n{#if hasIcon}<p>Icon</p>{/if}\n<p>base</p>`;
const SUB_EDITED = SUB.replace('<p>base</p>', '<p>BASE</p>');
const OTHER = `<script>\n  import Sub from './Sub.svelte';\n</script>\n<Sub hasIcon={false} />`;

describe('M6: dev incremental on the Rust engine matches the TS engine', () => {
  it('byte-identical to svelteShaker across an edit/add/remove sequence', async () => {
    const g = mutableGraph({ '/App.svelte': APP_NO_ICON, '/Sub.svelte': SUB });
    const dev = new RustDevShaker(g.resolve, g.readFile);

    const check = async (): Promise<Record<string, string>> => {
      const viaRust = await dev.shake(g.svelteIds());
      const viaTs = await svelteShaker(g.svelteIds(), g.resolve, g.readFile);
      expect(viaRust).toEqual(viaTs);
      for (const [id, code] of Object.entries(viaRust)) assertCompiles(code, id);
      return viaRust;
    };

    // init: hasIcon never passed -> folded -> Icon removed.
    expect((await check())['/Sub.svelte']).not.toContain('Icon');

    // edit a call site: App passes hasIcon={true} -> Sub keeps Icon.
    g.files['/App.svelte'] = APP_ICON;
    expect((await check())['/Sub.svelte']).toContain('Icon');

    // add a file passing a different value -> {true,false} -> Sub un-shakes.
    g.files['/Other.svelte'] = OTHER;
    expect((await check())['/Sub.svelte']).toContain('hasIcon');

    // remove it -> single `true` site -> folds again.
    delete g.files['/Other.svelte'];
    expect((await check())['/Sub.svelte']).toContain('Icon');

    // edit a leaf's own markup.
    g.files['/Sub.svelte'] = SUB_EDITED;
    expect((await check())['/Sub.svelte']).toContain('BASE');

    // drop the usage entirely -> Sub left untouched.
    g.files['/App.svelte'] = APP_NO_SUB;
    expect((await check())['/Sub.svelte']).toContain('hasIcon');
  });
});
