/**
 * Scan a whole resolved program for never-passed props (typed path — the default).
 *
 * `inputJson` is the JSON of `{ files: { id: string; code: string }[]; edges:
 * ResolvedEdge[] }` — the output of svelte-shaker's `buildAnalyzeInputSync` crawl
 * (resolution already done). Returns the JSON of `{ [fileId: string]: { name:
 * string; start: number; end: number }[] }` with UTF-16 offsets, keys sorted by
 * file id — the same shape as the WASM `find_never_passed_props_json` and the TS
 * `findNeverPassedProps`.
 *
 * Synchronous; requires Node >= 22.12.
 */
export declare function scan(inputJson: string): string;

/**
 * The Value-engine oracle / fallback: serializes each AST to the rsvelte JSON shape
 * and runs the validated `find_never_passed_props`. Output is identical to {@link
 * scan}; kept as the differential reference and a drop-in fallback.
 */
export declare function scanViaValue(inputJson: string): string;

/** Profiling helper: returns `{ typedMs, valueMs, files }` for the same input. */
export declare function scanProfile(inputJson: string): string;

/**
 * Chatty-protocol Round 1: parse every file with rsvelte (in parallel) and return
 * the small per-file facts the JS crawl needs to resolve module edges — without
 * shipping an AST across the boundary.
 *
 * `inputJson` is `{ files: { id: string; code: string }[] }`. Returns the JSON of
 * `{ files: { id: string; imports: { local: string; imported: string; source:
 * string }[]; renderedTags: string[]; memberTags: string[]; parseError: boolean }[] }`,
 * one entry per input file in input order. `imported` is `"default"`, `"*"`, or the
 * source's exported name; `renderedTags` are bare `<Local>` tags and `memberTags`
 * are dotted `<ns.X>` tags. Mirrors the JS `importSources` /
 * `renderedComponentTagNames` / `memberComponentTags`.
 */
export declare function parseFiles(inputJson: string): string;

/**
 * In-memory scan state for incremental re-scans (editor / LSP). Construct once,
 * `init` with the full program, then `update` per change set — `update` re-parses
 * only the changed files and re-runs the cheap whole-program assembly over the
 * cached models, so a single-file edit re-scans in ~1 ms instead of a full scan,
 * byte-identical to a cold {@link scan}.
 */
export declare class ScanDaemon {
  constructor();
  /** Full scan: parse every file and cache its model. Same input as {@link scan}. */
  init(inputJson: string): string;
  /**
   * Incremental re-scan. `inputJson` is `{ files: { id, code }[]; edges:
   * ResolvedEdge[]; removed?: string[] }` — `files` are the changed/added files,
   * `edges` the full current edge set, `removed` the deleted file ids.
   */
  update(inputJson: string): string;
}
