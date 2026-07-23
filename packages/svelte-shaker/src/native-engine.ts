import { createRequire } from 'node:module';
import {
  buildAnalyzeInput,
  type CrawlFacts,
  type FactsProvider,
  type ReadFile,
  type Resolve,
} from './analyze.js';
import { type MonomorphizeOptions } from './mono.js';
import { revertCascade } from './revert-cascade.js';
import type { ComponentId } from './ir.js';

// NODE-ONLY: loads the native Rust (napi) engine and drives it from the Vite plugin.
// Imported only by `vite.ts` (a Node entry), never by the environment-free engine, so
// the browser playground build stays clean. Unlike the WASM engine, this parses with
// rsvelte IN PROCESS and keeps the ASTs Rust-side (a `ShakeSession`), so no
// whole-program AST ever crosses the JS boundary — the crawl reads per-file FACTS from
// the session instead of re-parsing in JS (docs/RUST-MIGRATION.md M3).

const require = createRequire(import.meta.url);

/** The per-file facts JSON `ShakeSession.parse`/`parseMore` return (Round 1). */
interface NativeFacts {
  id: string;
  imports: { local: string; imported: string; source: string }[];
  renderedTags: string[];
  memberTags: string[];
  parseError: boolean;
}

/** The long-lived native session: parse + retain ASTs, then shake to edits. The
 * shake needs no size callback — the monomorphization net-win gate's compiled-byte
 * proxy is computed in-process by rsvelte (`session::own_size`), so the native path
 * never calls back into a JS compiler. */
interface ShakeSession {
  parse: (inputJson: string) => string;
  parseMore: (inputJson: string) => string;
  shake: (configJson: string) => string;
}

/** The subset of the napi addon the plugin uses. */
interface NativeEngine {
  ShakeSession: new () => ShakeSession;
  engineApiVersion: () => number;
}

/** The addon ABI generation this driver speaks (native `engine_api_version`). Bump
 * in lockstep with a breaking change to the exported methods. The 0.2.x addon's
 * `shake` took a JS `ownSize` callback; 0.3.x computes the size proxy in Rust and
 * `shake` takes ONE argument — calling a 0.2.x binary the 0.3.x way throws a napi
 * TypeError that crashes `vite build`, so a version mismatch MUST be rejected here. */
const EXPECTED_ENGINE_API_VERSION = 3;

/** Whether a loaded module is a native addon this engine can drive: the right ABI
 * generation AND the `ShakeSession` shape (`parse` + `parseMore` + `shake`). An OLDER
 * published `svelte-shaker-engine-scan-native` — one with no `engineApiVersion`, a
 * different generation, or predating `parseMore` — is REJECTED so the caller degrades
 * to WASM/JS instead of mis-calling an incompatible binary and crashing the build. */
export function hasSessionApi(mod: Partial<NativeEngine>): mod is NativeEngine {
  const versionFn = mod.engineApiVersion;
  // The 0.2.x addon has no `engineApiVersion` export, so this rejects it — the exact
  // skew that would otherwise throw on the new one-argument `shake` call.
  if (typeof versionFn !== 'function' || versionFn() !== EXPECTED_ENGINE_API_VERSION) return false;
  const ctor = mod.ShakeSession as (new () => ShakeSession) | undefined;
  const proto = ctor?.prototype as Partial<ShakeSession> | undefined;
  return (
    typeof ctor === 'function' &&
    typeof proto?.parse === 'function' &&
    typeof proto?.parseMore === 'function' &&
    typeof proto?.shake === 'function'
  );
}

/**
 * Load the native Rust (napi) engine, or `null` if it can't be loaded (then the caller
 * falls back to the WASM / JS engine). Two locations are tried in order:
 *  - the published `svelte-shaker-engine-scan-native` package (an
 *    `optionalDependency` — installed only when a prebuilt binary exists for this
 *    platform); this is the layout an npm consumer gets.
 *  - `../engine-scan-native/index.cjs` — the in-repo package, used from source in
 *    this package's own tests / dev (where the npm package isn't a dependency).
 * Either loader resolves the platform `.node`; a missing binary throws (swallowed).
 * A resolved-but-API-incompatible module (an older publish) is rejected so a version
 * skew degrades to a fallback engine, never a crash.
 */
export function tryLoadNativeEngine(): NativeEngine | null {
  for (const spec of ['svelte-shaker-engine-scan-native', '../engine-scan-native/index.cjs']) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(spec) as Partial<NativeEngine>;
      if (hasSessionApi(mod))
        return { ShakeSession: mod.ShakeSession, engineApiVersion: mod.engineApiVersion };
    } catch {
      // Not resolvable here — try the next location.
    }
  }
  return null;
}

/**
 * One native facts record → the crawl's {@link CrawlFacts}. An unparseable file is
 * treated as contributing nothing (its retained AST is Null, so the shake skips it —
 * sound under-shake), matching the session's own parse-error handling; a file with no
 * instance script simply has empty imports, so it resolves no edges either way.
 */
function toCrawlFacts(f: NativeFacts): CrawlFacts | null {
  if (f.parseError) return null;
  return {
    imports: f.imports.map((i) => ({ value: i.source, local: i.local, imported: i.imported })),
    renderedTags: new Set(f.renderedTags),
    memberTags: new Set(f.memberTags),
  };
}

/** The output of a native monomorphization shake: the wired owner files + the variant
 * residuals keyed by their request specifier (what the Shell's `load` hook serves). */
export interface NativeMonoResult {
  files: Record<ComponentId, string>;
  variants: Map<string, string>;
}

/**
 * Whole-program shake via the native Rust engine — the counterpart of
 * {@link svelteShakerWithMono} / {@link svelteShakerWasmWithMono}, handling
 * monomorphization too (mono off → an empty variant set).
 *
 * The seed components are parsed ONCE by the session (a batched, parallel rsvelte
 * parse); the crawl then resolves edges reading those facts instead of re-parsing in
 * JS, parsing any file discovered outside the seed on demand (`parseMore`). The
 * session retains every AST, so the shake needs no AST at the boundary — only the
 * resolved graph crosses, and the monomorphization size proxy is computed in-process
 * by rsvelte (`session::own_size`), so nothing calls back into a JS compiler. A final
 * svelte/compiler revert cascade (the AUTHORITY) force-bails any residual unparseable
 * output; the session's own inner rsvelte cascade means valid programs settle in one
 * outer pass.
 */
export async function svelteShakerNativeWithMono(
  engine: NativeEngine,
  entries: ComponentId | ComponentId[],
  resolve: Resolve,
  readFile: ReadFile,
  mono: MonomorphizeOptions,
  escaped: ComponentId[] = [],
): Promise<NativeMonoResult> {
  const seedIds = Array.isArray(entries) ? entries : [entries];
  // Batch-read + batch-parse the seed. Cache the source so the crawl's `readFile`
  // does not read the seed a second time.
  const codeCache = new Map<ComponentId, string>();
  const seedFiles = await Promise.all(
    seedIds.map(async (id) => {
      const code = await readFile(id);
      codeCache.set(id, code);
      return { id, code };
    }),
  );
  const session = new engine.ShakeSession();
  const seedFacts = JSON.parse(session.parse(JSON.stringify({ files: seedFiles }))) as {
    files: NativeFacts[];
  };
  const factsById = new Map<ComponentId, CrawlFacts | null>();
  for (const f of seedFacts.files) factsById.set(f.id, toCrawlFacts(f));

  const cachedRead: ReadFile = async (id) => {
    const hit = codeCache.get(id);
    if (hit !== undefined) return hit;
    const code = await readFile(id);
    codeCache.set(id, code);
    return code;
  };

  // Facts source for the crawl: a seed hit, or parse the newly discovered file into the
  // session now (retaining its AST for the shake) and cache its facts.
  const provider: FactsProvider = (id, code) => {
    if (factsById.has(id)) return factsById.get(id)!;
    const res = JSON.parse(session.parseMore(JSON.stringify({ files: [{ id, code }] }))) as {
      files: NativeFacts[];
    };
    const facts = res.files.length > 0 ? toCrawlFacts(res.files[0]!) : null;
    factsById.set(id, facts);
    return facts;
  };

  const input = await buildAnalyzeInput(
    entries,
    resolve,
    cachedRead,
    undefined,
    undefined,
    escaped,
    provider,
  );

  const config = {
    edges: input.edges,
    entries: input.entries,
    escaped: input.escaped ?? [],
    mono,
  };
  let last!: { files: Record<ComponentId, string>; variants: Record<string, string> };
  const files = revertCascade(input.files, (forceBail) => {
    last = JSON.parse(session.shake(JSON.stringify({ ...config, forceBail: [...forceBail] }))) as {
      files: Record<ComponentId, string>;
      variants: Record<string, string>;
    };
    return last.files;
  });
  // The engine already keys each variant by its `?shaker_variant=` request specifier
  // (mono.rs `variant_specifier`), the same key the `load` hook serves — so pass it
  // through, exactly as the WASM engine does.
  return { files, variants: new Map(Object.entries(last.variants)) };
}
