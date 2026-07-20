import type { Parse, Root } from '../src/parse';
import { tryLoadRsvelteParser } from '../src/rsvelte-parse';

// ----------------------------------------------------------------------
// Test-only bridge to the rsvelte (Rust/OXC) parser, exposed as a drop-in for
// `parseSvelte` (docs/RUST-MIGRATION.md §3 M3).  It reuses the SHIPPED loader
// (`tryLoadRsvelteParser`, backed by the `@rsvelte/compiler` WASM build) so the
// oracle exercises the exact code the Vite plugin runs — one parser path, not a
// second copy.
//
// The point is the differential oracle in rsvelte-diff.test.ts: seed the engine's
// ParseCache with these ASTs and assert the SAME shaken output as the
// svelte/compiler path.  This proves the Rust parser can drive the (still-TS)
// analysis+transform unchanged — the first concrete step of the Rust port.
// ----------------------------------------------------------------------

let parse: Parse | null = null;

/** Parse `.svelte` source with rsvelte, returning the same AST shape the engine
 * reads from svelte/compiler's modern parse (docs §3 M3). */
export function rsvelteParse(code: string): Root {
  parse ??= tryLoadRsvelteParser();
  if (!parse) throw new Error('@rsvelte/compiler could not be loaded');
  return parse(code, '');
}
