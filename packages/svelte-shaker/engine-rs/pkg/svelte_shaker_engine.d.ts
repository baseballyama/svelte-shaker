/* tslint:disable */
/* eslint-disable */

/**
 * Analyze one component AST (JSON) given its resolved outgoing edges (JSON), and
 * return the per-file model fields ported so far: declared props, `...rest`
 * presence, shadowed / `{@debug}` fold-blocking names, the `<svelte:options>`
 * bail, the rendered child calls, and escaped components. `{"error": "..."}` on
 * malformed input.
 */
export function analyze_component(ast_json: string, edges_json: string): string;

/**
 * Whole-program analysis entry: `input` is `{ files: [{id, ast}], edges:
 * [{from, local, to, kind}], entries }` (the AST is parsed on the JS side).
 * Returns `{ id: plan }` for every component.
 */
export function analyze_program(input_json: string): string;

/**
 * Whole-program shake: analyze + transform.  `input` is `{ files: [{id, ast,
 * code}], edges, entries }`.  Returns `{ id: slimmedSource }` for every file —
 * byte-for-byte the L0/L1/L1.5 output (the `svelteShaker` equivalent).
 */
export function shake_program(input_json: string): string;
