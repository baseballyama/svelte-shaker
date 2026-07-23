import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Parse, Root } from './parse.js';
import type { OwnSize } from './mono.js';

// NODE-ONLY: loads rsvelte's parser from `@rsvelte/compiler` — rsvelte's
// parser/compiler shipped as a `wasm-pack --target web` WASM module. It is a
// normal dependency of this package (platform-independent, no native binary), so
// consumers get it with a plain install and never wire up a peer. Imported only
// by the Vite plugin (`vite.ts`, an ESM/Node entry), never by the environment-
// free engine (`index.ts`/`analyze.ts`), so the browser playground build stays
// clean.

const require = createRequire(import.meta.url);

/** The wasm-pack `--target web` bytes shipped in `@rsvelte/compiler`, reached via
 * the package's stable `./wasm` subpath export (added upstream in 0.8.1). Using
 * the public subpath keeps the loader independent of the internal crate name that
 * determines the actual artifact basename. */
const WASM_FILE = '@rsvelte/compiler/wasm';

interface RsvelteCompiler {
  initSync: (module: { module: BufferSource }) => unknown;
  parse_svelte: (source: string) => { success: boolean; ast: string; error?: string | undefined };
  compile_client: (
    source: string,
    name: string,
  ) => { success: boolean; js: string; css: string; error?: string | undefined };
}

let ready = false;

/** Require `@rsvelte/compiler` and initialize its wasm once. Throws if the
 * package can't be resolved or the wasm can't be instantiated. */
function loadCompiler(): RsvelteCompiler {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const compiler = require('@rsvelte/compiler') as RsvelteCompiler;
  if (!ready) {
    // A `wasm-pack --target web` module: init once with the wasm bytes (Node has
    // no fetch for file URLs), after which `parse_svelte` is callable.
    const wasmPath = require.resolve(WASM_FILE);
    compiler.initSync({ module: readFileSync(wasmPath) });
    ready = true;
  }
  return compiler;
}

/**
 * Build a {@link Parse} backed by rsvelte's parser (`@rsvelte/compiler`, a
 * bundled WASM dependency), or `null` if that module can't be loaded/initialized
 * (a broken install, or an environment that can't instantiate the wasm). Since
 * rsvelte is the default parser, the caller THROWS on `null` rather than silently
 * using svelte/compiler; `parser: 'svelte'` is the explicit opt-out.
 *
 * rsvelte's AST positions match svelte/compiler's — UTF-16 code-unit offsets — so
 * the AST feeds the engine directly (`@rsvelte/compiler` <= 0.6 reported UTF-8
 * *byte* offsets and needed a remap; 0.7 emits UTF-16, so the remap is gone).
 * A genuine parse error on a specific file is a real failure and PROPAGATES; only
 * a load/init failure returns `null`.
 */
export function tryLoadRsvelteParser(): Parse | null {
  let compiler: RsvelteCompiler;
  try {
    compiler = loadCompiler();
  } catch {
    return null;
  }
  return (code) => {
    const result = compiler.parse_svelte(code);
    if (!result.success) throw new Error(`rsvelte parse failed: ${result.error ?? 'unknown'}`);
    return JSON.parse(result.ast) as Root;
  };
}

/**
 * Build the rsvelte-backed {@link OwnSize} for the JS/WASM engines, or `null` if
 * `@rsvelte/compiler` can't be loaded/initialized. The native engine computes the
 * SAME proxy in-process (`session::own_size` over the pinned rsvelte crate), so all
 * three engines' monomorphization gates decide byte-for-byte alike (parity is
 * test-gated). `name` is passed as the component id — its exact string is immaterial
 * to the SIZE as long as every engine passes the same one, which they do.
 */
export function tryLoadRsvelteOwnSize(): OwnSize | null {
  let compiler: RsvelteCompiler;
  try {
    compiler = loadCompiler();
  } catch {
    return null;
  }
  return (id, source) => {
    const result = compiler.compile_client(source, id);
    return result.success ? result.js.length : null;
  };
}
