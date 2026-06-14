import { createRequire } from 'node:module';
import { buildAnalyzeInput, type ReadFile, type Resolve } from './analyze.js';
import { parseCached, parseSvelte, type Parse, type ParseCache } from './parse.js';
import type { ComponentId } from './ir.js';

// NODE-ONLY: loads the native Rust (WASM) engine and drives it from the Vite
// plugin.  Imported only by `vite.ts` (a Node entry), never by the environment-free
// engine (`index.ts`/`analyze.ts`), so the browser playground build stays clean.

const require = createRequire(import.meta.url);

/** The subset of the WASM exports the plugin uses (docs/RUST-MIGRATION.md M5). */
interface WasmEngine {
  /** Whole-program L0/L1/L1.5 shake: input JSON in, `{id: shakenCode}` JSON out. */
  shake_program: (inputJson: string) => string;
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
      if (typeof mod.shake_program === 'function')
        return { shake_program: mod.shake_program.bind(mod) };
    } catch {
      // Try the next location.
    }
  }
  return null;
}

/**
 * Whole-program shake via the native Rust engine — the L0/L1/L1.5 counterpart of
 * {@link svelteShaker} (L2 lives only in the JS engine).  The crawl/resolution
 * stays in JS ({@link buildAnalyzeInput}); we hand the Rust engine the resolved
 * graph plus each file's AST and source as JSON, exactly as the differential
 * `wasm-shake` test does — so the output is byte-identical to the JS engine.
 *
 * The same parse cache feeds the crawl and the program input, so each file is
 * parsed once.  A final self-check mirrors the JS engine's `revertUnparseable`:
 * any emitted file that no longer parses is reverted to its original (a sound
 * "did not shake this component"), so a single mishandled shape can never break
 * the build.
 */
export async function svelteShakerWasm(
  engine: WasmEngine,
  entries: ComponentId | ComponentId[],
  resolve: Resolve,
  readFile: ReadFile,
  parse?: Parse,
): Promise<Record<ComponentId, string>> {
  const cache: ParseCache = new Map();
  const input = await buildAnalyzeInput(entries, resolve, readFile, cache, parse);
  const programInput = {
    files: input.files.map((f) => ({
      id: f.id,
      ast: parseCached(f.id, f.code, cache, parse),
      code: f.code,
    })),
    edges: input.edges,
    entries: input.entries,
  };
  const out = JSON.parse(engine.shake_program(JSON.stringify(programInput))) as Record<
    ComponentId,
    string
  >;

  for (const file of input.files) {
    const code = out[file.id];
    if (code === undefined || code === file.code) continue;
    try {
      parseSvelte(code, file.id);
    } catch {
      out[file.id] = file.code;
    }
  }
  return out;
}
