import { analyzeInput, buildAnalyzeInput, type ReadFile, type Resolve } from './analyze.js';
import { transformAll } from './transform.js';
import type { Parse, ParseCache } from './parse.js';
import type { ComponentId, EditResult } from './ir.js';

/**
 * dev shake granularity (docs/RUST-MIGRATION.md §3 M2 / ARCHITECTURE §6.2):
 *  - `'coarse'`     — every change re-reads, re-parses, and re-analyzes the whole
 *                     program from scratch.  Trivially correct; the safety valve.
 *  - `'incremental'`— re-reads and re-parses ONLY the changed/added files (the
 *                     dominant cost), then re-runs the whole-program fixpoint and
 *                     transform over the cached models.  The fixpoint still reads
 *                     EVERY file, so the inverted "all importers" dependency can
 *                     never be missed — the result is identical to `'coarse'`,
 *                     only faster.  The differential oracle (tests/dev.test.ts)
 *                     pins `incremental === coarse === full` for every edit.
 */
export type DevMode = 'coarse' | 'incremental';

/** Which files the Shell observed change since the last update. */
export interface DevShakerChange {
  /** Existing files whose content changed (re-read from disk). */
  changed?: ComponentId[];
  /** Newly-created files now in the program. */
  added?: ComponentId[];
  /** Deleted files. */
  removed?: ComponentId[];
}

/**
 * A long-lived, incremental whole-program shaker for `vite dev` (docs §2.1, §3
 * M2).  Construct it with the FULL file set (the Shell's FS scan — the call-site
 * completeness boundary, ARCHITECTURE §6.2) and the same `resolve`/`readFile` the
 * build path uses; call {@link init} once, then {@link update} on every file
 * change.  `update` returns the components whose SLIMMED OUTPUT changed, which the
 * Shell turns into the widened HMR boundary.
 *
 * monomorphization is intentionally NOT applied in dev (its net-win gate is a
 * whole-program measurement that is expensive to keep incrementally correct); dev
 * covers unused-prop fold / constant fold / value-set narrowing only (docs §5 risks).
 */
export class DevShaker {
  private readonly entries = new Set<ComponentId>();
  private readonly resolve: Resolve;
  private readonly readFile: ReadFile;
  private readonly mode: DevMode;
  /** Non-default parser (e.g. rsvelte), or `undefined` for svelte/compiler. */
  private readonly parse: Parse | undefined;

  /** Content-keyed AST cache — only changed files re-parse (§2.2). */
  private readonly parseCache: ParseCache = new Map();
  /** Last-seen source per file, so an update re-reads only what changed. */
  private readonly codeCache = new Map<ComponentId, string>();
  /** Components with a consumer outside the `.svelte` graph (docs §4.2): a
   * `.ts`/`.js` call site or a user `preserve`.  The Shell recomputes and
   * {@link setEscaped}s this whenever a non-`.svelte` module changes. */
  private escaped: ComponentId[];

  /** Current slimmed output per `.svelte` id (the live shake result). */
  private output: Record<ComponentId, string> = {};

  constructor(
    files: ComponentId | ComponentId[],
    resolve: Resolve,
    readFile: ReadFile,
    mode: DevMode = 'incremental',
    parse?: Parse,
    escaped: ComponentId[] = [],
  ) {
    for (const id of Array.isArray(files) ? files : [files]) this.entries.add(id);
    this.resolve = resolve;
    this.readFile = readFile;
    this.mode = mode;
    this.parse = parse;
    this.escaped = escaped;
  }

  /** Replace the external-escape set (docs §4.2).  The Shell calls this before
   * {@link update} when a non-`.svelte` module changed the set of components
   * reached from `.ts`/`.js`, so the next shake bails them. */
  setEscaped(escaped: ComponentId[]): void {
    this.escaped = escaped;
  }

  /** Full initial shake of the program.  Returns the slimmed source per file. */
  async init(): Promise<Record<ComponentId, string>> {
    this.output = await this.shake();
    return this.output;
  }

  /** The current slimmed source for a file, or `undefined` if not in the program. */
  get(id: ComponentId): string | undefined {
    return this.output[id];
  }

  /** A copy of the current whole-program output (every file's slimmed source). */
  snapshot(): Record<ComponentId, string> {
    return { ...this.output };
  }

  /**
   * Apply a batch of file changes and re-shake.  Returns the delta: the
   * components whose output changed (a superset of the edited files — a call-site
   * edit can change a child's residual) and the ones no longer in the program.
   */
  async update(change: DevShakerChange): Promise<EditResult> {
    const incremental = this.mode === 'incremental';

    for (const id of change.removed ?? []) {
      this.entries.delete(id);
      this.codeCache.delete(id);
      this.parseCache.delete(id);
    }
    for (const id of change.added ?? []) {
      this.entries.add(id);
      if (incremental) this.codeCache.set(id, await this.readFile(id));
    }
    for (const id of change.changed ?? []) {
      // Re-read into the code cache; `parseCached` re-parses on the content
      // mismatch, so no explicit parse-cache invalidation is needed here.
      if (incremental) this.codeCache.set(id, await this.readFile(id));
    }

    const prev = this.output;
    const next = await this.shake();
    this.output = next;

    const changed: Record<ComponentId, string> = {};
    for (const id of Object.keys(next)) {
      if (prev[id] !== next[id]) changed[id] = next[id]!;
    }
    const removed = Object.keys(prev).filter((id) => !(id in next));
    return { changed, removed };
  }

  /**
   * Run the whole-program shake.  In `'incremental'` mode it reads through the
   * code/parse caches (so unchanged files are neither re-read nor re-parsed); in
   * `'coarse'` mode it bypasses both for a from-scratch rebuild.  Both produce
   * identical output — only the work differs.
   */
  private async shake(): Promise<Record<ComponentId, string>> {
    const useCache = this.mode === 'incremental';
    const read = useCache ? this.cachedReadFile : this.readFile;
    // Share one cache between the crawl and the analysis so a non-default parser
    // runs once per file (persistent in incremental, a throwaway in coarse). With
    // the default parser this stays `undefined` in coarse mode — unchanged.
    const parseCache = useCache ? this.parseCache : this.parse ? new Map() : undefined;
    const input = await buildAnalyzeInput(
      [...this.entries],
      this.resolve,
      read,
      parseCache,
      this.parse,
      this.escaped,
    );
    const { models, plans } = analyzeInput(input, parseCache);
    return transformAll(models, plans);
  }

  /** Read through the code cache, disk-reading and caching on a miss. */
  private readonly cachedReadFile: ReadFile = async (id) => {
    const cached = this.codeCache.get(id);
    if (cached !== undefined) return cached;
    const code = await this.readFile(id);
    this.codeCache.set(id, code);
    return code;
  };
}
