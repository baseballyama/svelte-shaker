import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Parse, Root } from './parse.js';
import { remapRsvelteOffsets } from './rsvelte-utf16.js';

// NODE-ONLY: loads rsvelte's parser from `@rsvelte/compiler` — rsvelte's
// parser/compiler shipped as a `wasm-pack --target web` WASM module. It is a
// normal dependency of this package (platform-independent, no native binary), so
// consumers get it with a plain install and never wire up a peer. Imported only
// by the Vite plugin (`vite.ts`, an ESM/Node entry), never by the environment-
// free engine (`index.ts`/`analyze.ts`), so the browser playground build stays
// clean.

const require = createRequire(import.meta.url);

interface RsvelteCompiler {
  initSync: (module: { module: BufferSource }) => unknown;
  parse_svelte: (source: string) => { success: boolean; ast: string; error?: string | undefined };
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
    const wasmPath = require.resolve('@rsvelte/compiler/rsvelte_core_bg.wasm');
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
 * rsvelte reports positions as UTF-8 *byte* offsets, but the engine expects
 * svelte/compiler's UTF-16 *code-unit* offsets, so {@link remapRsvelteOffsets}
 * rewrites them before the AST leaves this function — without it, a multibyte
 * character ahead of an edit desyncs the transform (see `rsvelte-utf16.ts`).
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
    return remapRsvelteOffsets(JSON.parse(result.ast) as Root, code);
  };
}
