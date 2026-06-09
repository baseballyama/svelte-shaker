import { createRequire } from 'node:module';
import type { Parse, Root } from './parse';

// NODE-ONLY: dynamically loads the OPTIONAL native rsvelte parser. Imported only
// by the Vite plugin (`vite.ts`, an ESM/Node entry), never by the environment-free
// engine (`index.ts`/`analyze.ts`), so the browser playground build stays clean.

const require = createRequire(import.meta.url);

interface RsvelteNative {
  parse?: (source: string, options?: { skipExpressionLoc?: boolean }) => string;
}

/**
 * Build a {@link Parse} backed by rsvelte's native parser
 * (`@rsvelte/vite-plugin-svelte-native`), or `null` if that OPTIONAL peer package
 * can't be loaded (not installed / unsupported platform) — the caller then falls
 * back to svelte/compiler.
 *
 * `skipExpressionLoc: true` is REQUIRED, not cosmetic: the per-expression `loc`
 * blocks roughly double the AST and make the engine's walk the dominant cost
 * (full-pipeline 0.72x WITH them vs 1.46x WITHOUT) — and the engine reads only
 * UTF-16 `start`/`end`, never `loc`, so dropping them leaves the output identical
 * (docs/RUST-MIGRATION.md §6).
 */
export function tryLoadRsvelteParser(): Parse | null {
  let native: RsvelteNative;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    native = require('@rsvelte/vite-plugin-svelte-native') as RsvelteNative;
  } catch {
    return null;
  }
  const parse = native.parse;
  if (typeof parse !== 'function') return null;
  return (code) => JSON.parse(parse(code, { skipExpressionLoc: true })) as Root;
}
