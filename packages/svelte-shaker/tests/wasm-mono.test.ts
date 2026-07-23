import { join, resolve as resolvePath } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { buildAnalyzeInput, svelteShakerWithMono, type ComponentId } from '../src/index';
import { parseSvelte } from '../src/parse';
import { tryLoadRsvelteOwnSize } from '../src/rsvelte-parse';
import { fsReadFile, fsResolve } from '../src/scan';

// ----------------------------------------------------------------------
// monomorphization in Rust (docs/RUST-MIGRATION.md): `shake_program_with_mono` is the Rust→WASM
// port of `svelteShakerWithMono` (mono.ts + the transform.ts call-site rewrite).
// The only thing crossing back to JS is the `ownSize` size proxy (rsvelte's client
// codegen via `@rsvelte/compiler`), so feeding BOTH engines the same proxy makes the
// result byte-identical. This is the gate: for every fixture, Rust's `files` AND its
// variant set must match the TS engine exactly — a byte match means the Rust
// monomorphization is sound (the TS output is the audited, differential-SSR-tested reference).
// ----------------------------------------------------------------------

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports
const wasm = require('../engine-rs/pkg/svelte_shaker_engine.js') as {
  shake_program_with_mono: (
    inputJson: string,
    optionsJson: string,
    ownSize: (id: string, source: string) => number | null,
  ) => string;
};

const MONO = { enabled: true, maxVariants: 8, minSavings: 0 };

// The size proxy both engines use: rsvelte's client-compiled byte length, the same
// proxy the native engine computes in-process (so all three engines agree).
const ownSize = tryLoadRsvelteOwnSize() ?? ((): number | null => null);

/** `<childId>::v<n>` -> `<childId>?shaker_variant=<n>` (mirrors vite.ts). */
function variantSpecifier(variantId: string): string {
  const sep = variantId.lastIndexOf('::v');
  return `${variantId.slice(0, sep)}?shaker_variant=${variantId.slice(sep + 3)}`;
}

async function tsMono(entry: ComponentId): Promise<{
  files: Record<string, string>;
  variants: Record<string, string>;
}> {
  const result = await svelteShakerWithMono(
    entry,
    fsResolve,
    fsReadFile,
    MONO,
    variantSpecifier,
    undefined,
    undefined,
    ownSize,
  );
  const variants: Record<string, string> = {};
  for (const v of result.mono.variants.values()) variants[variantSpecifier(v.id)] = v.code;
  return { files: result.files, variants };
}

async function rustMono(entry: ComponentId): Promise<{
  files: Record<string, string>;
  variants: Record<string, string>;
}> {
  const input = await buildAnalyzeInput(entry, fsResolve, fsReadFile);
  const programInput = {
    files: input.files.map((f) => ({ id: f.id, ast: parseSvelte(f.code, f.id), code: f.code })),
    edges: input.edges,
    entries: input.entries,
  };
  return JSON.parse(
    wasm.shake_program_with_mono(JSON.stringify(programInput), JSON.stringify(MONO), ownSize),
  );
}

const FIXTURES = resolvePath(__dirname, 'fixtures');

describe('Rust (WASM) monomorphization matches the TS engine', () => {
  for (const name of [
    'mono-correlated', // monomorphization genuinely fires: variants emitted, owner rewritten
    'mono-japanese', // like mono-correlated but with non-ASCII text — exercises the UTF-16 size proxy
    'basic1', // no monomorphization candidate: variants empty, files == base shake
    'cascade',
    'narrow-variant',
    'fold-ternary',
    'spread-const-object',
  ]) {
    it(`${name}: files + variants match svelteShakerWithMono`, async () => {
      const entry = join(FIXTURES, name, 'input', 'App.svelte');
      const ts = await tsMono(entry);
      const rust = await rustMono(entry);
      expect(rust.files).toEqual(ts.files);
      expect(rust.variants).toEqual(ts.variants);
    });
  }

  it('mono-correlated actually exercises the variant path (sanity)', async () => {
    const entry = join(FIXTURES, 'mono-correlated', 'input', 'App.svelte');
    const ts = await tsMono(entry);
    // At least one variant was emitted, and the `<Heavy>` element is gone from the
    // residual template (the now-unused import is left for the bundler to drop).
    expect(Object.keys(ts.variants).length).toBeGreaterThan(0);
    for (const code of Object.values(ts.variants)) expect(code).not.toContain('<Heavy');
  });
});
