/**
 * Scan a whole resolved program for never-passed props.
 *
 * `inputJson` is the JSON of `{ files: { id: string; code: string }[]; edges:
 * ResolvedEdge[] }` — the output of svelte-shaker's `buildAnalyzeInputSync`
 * crawl (resolution already done). Returns the JSON of `{ [fileId: string]: {
 * name: string; start: number; end: number }[] }` with UTF-16 offsets — the same
 * shape as the WASM `find_never_passed_props_json` and the TS `findNeverPassedProps`.
 *
 * Synchronous (the addon parses + analyzes in-process); requires Node >= 22.12.
 */
export declare function scan(inputJson: string): string;
