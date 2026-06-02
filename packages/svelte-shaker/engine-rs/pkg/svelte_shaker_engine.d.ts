/* tslint:disable */
/* eslint-disable */

/**
 * Analyze one component AST (JSON) given its resolved outgoing edges (JSON), and
 * return the per-file model fields ported so far: declared props, `...rest`
 * presence, shadowed / `{@debug}` fold-blocking names, the `<svelte:options>`
 * bail, the rendered child calls, barrel-rendered children, and escaped
 * components. `{"error": "..."}` on malformed input.
 */
export function analyze_component(ast_json: string, edges_json: string): string;
