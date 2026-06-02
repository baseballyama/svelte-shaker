/* tslint:disable */
/* eslint-disable */

/**
 * Extract declared prop names + whole-component bail reasons from a component
 * AST (JSON). Returns `{"props": [...], "bail": [...]}` or `{"error": "..."}`.
 */
export function analyze_props(ast_json: string): string;
