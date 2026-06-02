import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import type { Root } from '../src/parse';

// ----------------------------------------------------------------------
// Test-only bridge to the rsvelte (Rust/OXC) parser, exposed as a drop-in for
// `parseSvelte` (docs/RUST-MIGRATION.md §3 M3).  It loads the published WASM
// build of rsvelte (`@rsvelte/compiler`, a devDependency — never imported by
// the shipped engine), parses a `.svelte` source, and returns the JSON AST.
//
// The point is the differential oracle in rsvelte-diff.test.ts: seed the engine's
// ParseCache with these ASTs and assert the SAME shaken output as the
// svelte/compiler path.  This proves the Rust parser can drive the (still-TS)
// analysis+transform unchanged — the first concrete step of the Rust port.
// ----------------------------------------------------------------------

const require = createRequire(import.meta.url);

let ready = false;
function ensureInit(): void {
  if (ready) return;
  // `@rsvelte/compiler` is a `wasm-pack --target web` module: init once with the
  // wasm bytes (Node has no fetch for file URLs), then `parse_svelte` is callable.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const wasm = require('@rsvelte/compiler');
  const wasmPath = require.resolve('@rsvelte/compiler/rsvelte_core_bg.wasm');
  wasm.initSync({ module: fs.readFileSync(wasmPath) });
  ready = true;
}

/** Parse `.svelte` source with rsvelte, returning the same AST shape the engine
 * reads from svelte/compiler's modern parse (docs §3 M3). */
export function rsvelteParse(code: string): Root {
  ensureInit();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { parse_svelte } = require('@rsvelte/compiler');
  const result = parse_svelte(code);
  if (!result.success) throw new Error(`rsvelte parse failed: ${result.error ?? 'unknown'}`);
  return JSON.parse(result.ast) as Root;
}
