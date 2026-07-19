import { createRequire } from 'node:module';
import { compile } from 'svelte/compiler';
import { buildAnalyzeInput, type ReadFile, type Resolve } from './analyze.js';
import { parseCached, type Parse, type ParseCache } from './parse.js';
import { type MonomorphizeOptions } from './mono.js';
import { revertCascade } from './revert-cascade.js';
import type { ComponentId } from './ir.js';

// NODE-ONLY: loads the native Rust (WASM) engine and drives it from the Vite
// plugin.  Imported only by `vite.ts` (a Node entry), never by the environment-free
// engine (`index.ts`/`analyze.ts`), so the browser playground build stays clean.

const require = createRequire(import.meta.url);

/** The subset of the WASM exports the plugin uses (docs/RUST-MIGRATION.md M5+). */
interface WasmEngine {
  /** Whole-program unused-prop fold / constant fold / value-set narrowing shake: input JSON in, `{id: shakenCode}` JSON out. */
  shake_program: (inputJson: string) => string;
  /**
   * Whole-program shake WITH monomorphization.  `ownSize(id, source)` is the
   * per-module compiled-byte proxy the net-win gate calls back into JS for (the
   * Svelte compiler has no in-WASM equivalent); returns
   * `{ files: {id: code}, variants: {specifier: code} }` JSON.
   */
  shake_program_with_mono: (
    inputJson: string,
    optionsJson: string,
    ownSize: (id: string, source: string) => number | null,
  ) => string;
}

/**
 * Load the native Rust (WASM) engine, or `null` if it can't be loaded (no built
 * artifact for this install).  Two locations are tried in order:
 *  - `./svelte_shaker_engine.js` — the PUBLISHED layout, where `build` copies the
 *    artifact next to `dist/wasm-engine.js` (wasm-pack's `pkg/.gitignore` of `*`
 *    keeps `engine-rs/pkg` out of the npm tarball, so we ship it via `dist/`).
 *  - `../engine-rs/pkg/svelte_shaker_engine.js` — the REPO layout, used when
 *    running from source in the package's own tests (no copy step has run).
 */
export function tryLoadWasmEngine(): WasmEngine | null {
  for (const spec of ['./svelte_shaker_engine.js', '../engine-rs/pkg/svelte_shaker_engine.js']) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(spec) as Partial<WasmEngine>;
      if (
        typeof mod.shake_program === 'function' &&
        typeof mod.shake_program_with_mono === 'function'
      )
        return {
          shake_program: mod.shake_program.bind(mod),
          shake_program_with_mono: mod.shake_program_with_mono.bind(mod),
        };
    } catch {
      // Try the next location.
    }
  }
  return null;
}

/** The compiled-byte size proxy the monomorphization net-win gate uses — the same call
 * `mono.ts` makes, so the Rust gate decides byte-for-byte like the JS engine. */
function ownSize(id: ComponentId, source: string): number | null {
  try {
    return compile(source, { generate: 'client', dev: false, filename: id }).js.code.length;
  } catch {
    return null;
  }
}

/**
 * Whole-program shake via the native Rust engine — the unused-prop fold / constant fold / value-set narrowing counterpart of
 * {@link svelteShaker} (monomorphization lives only in the JS engine).  The crawl/resolution
 * stays in JS ({@link buildAnalyzeInput}); we hand the Rust engine the resolved
 * graph plus each file's AST and source as JSON, exactly as the differential
 * `wasm-shake` test does — so the output is byte-identical to the JS engine.
 *
 * The same parse cache feeds the crawl and the program input, so each file is
 * parsed once.  A final self-check mirrors the JS engine's revert cascade
 * ({@link revertCascade}): any emitted file that no longer parses is
 * force-bailed and the whole shake re-run, so a single mishandled shape can never
 * break the build nor leave a parent's call-site edits inconsistent.
 */
export async function svelteShakerWasm(
  engine: WasmEngine,
  entries: ComponentId | ComponentId[],
  resolve: Resolve,
  readFile: ReadFile,
  parse?: Parse,
  escaped: ComponentId[] = [],
): Promise<Record<ComponentId, string>> {
  const cache: ParseCache = new Map();
  const input = await buildAnalyzeInput(entries, resolve, readFile, cache, parse, escaped);
  const programInput = {
    files: input.files.map((f) => ({
      id: f.id,
      ast: parseCached(f.id, f.code, cache, parse),
      code: f.code,
    })),
    edges: input.edges,
    entries: input.entries,
    escaped: input.escaped ?? [],
  };
  return revertCascade(
    input.files,
    (forceBail) =>
      JSON.parse(
        engine.shake_program(JSON.stringify({ ...programInput, forceBail: [...forceBail] })),
      ) as Record<ComponentId, string>,
  );
}

/** The output of a Rust monomorphization shake: the wired owner files + the variant residuals
 * keyed by their request specifier (what the Shell's `load` hook serves). */
export interface WasmMonoResult {
  files: Record<ComponentId, string>;
  variants: Map<string, string>;
}

/**
 * Whole-program shake WITH monomorphization, run entirely in the native Rust
 * engine — the counterpart of {@link svelteShakerWithMono}.  The crawl/resolution
 * stays in JS; the Rust engine does the analysis, the monomorphization graph/gate, and the
 * call-site rewrite, calling back into JS only for {@link ownSize} (the Svelte
 * compiler).  Feeding it the same compiler the JS engine uses makes the result
 * byte-identical (pinned by the differential `wasm-mono` test).
 */
export async function svelteShakerWasmWithMono(
  engine: WasmEngine,
  entries: ComponentId | ComponentId[],
  resolve: Resolve,
  readFile: ReadFile,
  mono: MonomorphizeOptions,
  parse?: Parse,
  escaped: ComponentId[] = [],
): Promise<WasmMonoResult> {
  const cache: ParseCache = new Map();
  const input = await buildAnalyzeInput(entries, resolve, readFile, cache, parse, escaped);
  const programInput = {
    files: input.files.map((f) => ({
      id: f.id,
      ast: parseCached(f.id, f.code, cache, parse),
      code: f.code,
    })),
    edges: input.edges,
    entries: input.entries,
    escaped: input.escaped ?? [],
  };
  const options = JSON.stringify({
    enabled: mono.enabled,
    maxVariants: mono.maxVariants,
    minSavings: mono.minSavings,
  });
  let last!: { files: Record<ComponentId, string>; variants: Record<string, string> };
  const files = revertCascade(input.files, (forceBail) => {
    last = JSON.parse(
      engine.shake_program_with_mono(
        JSON.stringify({ ...programInput, forceBail: [...forceBail] }),
        options,
        ownSize,
      ),
    ) as { files: Record<ComponentId, string>; variants: Record<string, string> };
    return last.files;
  });
  return { files, variants: new Map(Object.entries(last.variants)) };
}
