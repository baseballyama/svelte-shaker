/* tslint:disable */
/* eslint-disable */

/**
 * Analyze one component AST (JSON), returning the per-file model fields ported
 * so far: declared props, whether a `...rest` is present, the shadowed /
 * `{@debug}` names that block folding, and the whole-component bail reasons.
 * `{"error": "..."}` on malformed input.
 */
export function analyze_component(ast_json: string): string;
