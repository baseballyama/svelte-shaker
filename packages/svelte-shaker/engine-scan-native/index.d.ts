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
 * Focused IR parity pin: `[{ name, start, end }]` for every `<Component>` the internal
 * template IR walk finds in `astJson` (svelte JSON) — so `ir-parity.test.ts` can assert
 * it equals the engine's Value walk. A native-only shim that exercises the IR walk
 * directly without touching the committed wasm.
 */
export declare function irComponentTags(astJson: string): string;

/**
 * Chatty-protocol Round 2: the native full-shake session. `parse` parses + retains
 * every file's AST (returning the Round-1 {@link parseFiles} facts); `shake` runs
 * the whole-program fold + monomorphization over the retained ASTs and returns only
 * the edits.
 *
 * The inner revert cascade (re-parse each emitted file with rsvelte, force-bail the
 * unparseable ones, re-run) is internal; the caller keeps a FINAL svelte/compiler
 * validation as the authority and feeds any residual failure back via `forceBail`.
 */
export declare class ShakeSession {
  constructor();
  /** Parse + retain `{ files: { id, code }[] }` (replacing any retained set); returns the {@link parseFiles} facts JSON. */
  parse(inputJson: string): string;
  /**
   * Additive parse for the incremental crawl: parse + retain only files whose id is
   * not already retained (dedup guards re-sends), appended in input order; returns the
   * {@link parseFiles} facts JSON for the NEWLY parsed files only.
   */
  parseMore(inputJson: string): string;
  /**
   * `configJson` is `{ edges: ResolvedEdge[]; entries?: string[]; escaped?: string[];
   * mono?: { enabled: boolean; maxVariants: number; minSavings: number }; forceBail?:
   * string[] }`. Returns `{ files: { [id]: code }; variants: { [specifier]: code } }` JSON.
   *
   * `ownSize` is the compiled-byte proxy the mono net-win gate calls. It receives a
   * SINGLE JSON string argument — `[id, source]` — and returns that source's compiled
   * size (svelte compile length) or `null` on failure. The single-arg form is a
   * deliberate workaround for a napi multi-arg marshaling bug; wrap a normal
   * `(id, source) => number | null` sizer as `(p) => size(...JSON.parse(p))`.
   */
  shake(configJson: string, ownSize: (payload: string) => number | null): string;
}

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
