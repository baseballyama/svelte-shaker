import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve as resolvePath } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildAnalyzeInput,
  svelteShakerWithMono,
  type ComponentId,
  type MonomorphizeOptions,
  type ReadFile,
  type Resolve,
} from '../src/index';
import { revertCascade } from '../src/revert-cascade';
import { tryLoadRsvelteOwnSize } from '../src/rsvelte-parse';
import { fsReadFile, fsResolve } from '../src/scan';
import { loadNativeAddon } from './native-addon';

/** An in-memory `.svelte` graph, so a test can pin exact sources (incl. an invalid one). */
function memGraph(files: Record<string, string>): { resolve: Resolve; readFile: ReadFile } {
  const resolve: Resolve = (source, importer) => {
    if (!source.startsWith('.')) return null;
    const base = importer.slice(0, importer.lastIndexOf('/'));
    const parts: string[] = [];
    for (const seg of `${base}/${source}`.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    return `/${parts.join('/')}`;
  };
  const readFile: ReadFile = (id) => {
    const code = files[id];
    if (code === undefined) throw new Error(`no such file: ${id}`);
    return code;
  };
  return { resolve, readFile };
}

// The native chatty full-shake (Round 2) must produce byte-for-byte the SAME output
// as the TS `svelteShakerWithMono` — the audited, differential-SSR-tested reference.
// The native path parses with rsvelte and shakes in-process through the engine-rs
// cores, computing the monomorphization size proxy IN RUST (rsvelte's client codegen)
// — nothing crosses back to a JS compiler. The TS reference measures the SAME proxy
// with `@rsvelte/compiler` (`compile_client`), so the results are byte-identical. This
// is the M2 gate: over the whole fixture/example/e2e corpus, native `files` AND its
// variant set must equal the TS engine, with monomorphization on and off.
interface ShakeSession {
  parse: (inputJson: string) => string;
  parseMore: (inputJson: string) => string;
  shake: (configJson: string) => string;
}
interface NativeAddon {
  ShakeSession: new () => ShakeSession;
}
const addon = loadNativeAddon<NativeAddon>();

const MONO_ON: MonomorphizeOptions = { enabled: true, maxVariants: 8, minSavings: 0 };
const MONO_OFF: MonomorphizeOptions = { enabled: false, maxVariants: 8, minSavings: 0 };

// The TS reference's size proxy, measured with `@rsvelte/compiler` — the JS-side
// counterpart of the native engine's in-Rust `session::own_size`. Both compile the
// same rsvelte rev, so the byte counts (and thus the gate decisions) match.
const ownSize = tryLoadRsvelteOwnSize() ?? ((): number | null => null);

/** `<childId>::v<n>` -> `<childId>?shaker_variant=<n>` (mirrors vite.ts). */
function variantSpecifier(variantId: string): string {
  const sep = variantId.lastIndexOf('::v');
  return `${variantId.slice(0, sep)}?shaker_variant=${variantId.slice(sep + 3)}`;
}

type Shaken = { files: Record<string, string>; variants: Record<string, string> };

async function tsShake(entry: ComponentId, mono: MonomorphizeOptions): Promise<Shaken> {
  const result = await svelteShakerWithMono(
    entry,
    fsResolve,
    fsReadFile,
    mono,
    variantSpecifier,
    undefined,
    undefined,
    ownSize,
  );
  const variants: Record<string, string> = {};
  for (const v of result.mono.variants.values()) variants[variantSpecifier(v.id)] = v.code;
  return { files: result.files, variants };
}

/**
 * The native chatty path, mirroring the future vite wiring: JS builds the resolved
 * graph, the Session retains the ASTs and shakes, and the OUTER svelte/compiler
 * revert cascade (the authority) force-bails any residual unparseable output. The
 * Session runs its own inner rsvelte cascade, so for valid programs this outer loop
 * settles in one pass.
 */
async function nativeShake(entry: ComponentId, mono: MonomorphizeOptions): Promise<Shaken> {
  const input = await buildAnalyzeInput(entry, fsResolve, fsReadFile);
  const session = new addon!.ShakeSession();
  session.parse(JSON.stringify({ files: input.files.map((f) => ({ id: f.id, code: f.code })) }));
  const config = {
    edges: input.edges,
    entries: input.entries,
    escaped: input.escaped ?? [],
    mono,
  };
  let last!: Shaken;
  const files = revertCascade(input.files, (forceBail) => {
    last = JSON.parse(
      session.shake(JSON.stringify({ ...config, forceBail: [...forceBail] })),
    ) as Shaken;
    return last.files;
  });
  return { files, variants: last.variants };
}

const FIXTURES = resolvePath(__dirname, 'fixtures');

describe.skipIf(!addon)('native ShakeSession matches svelteShakerWithMono', () => {
  it('monomorphization fires: variants emitted and owner rewritten (mono-correlated)', async () => {
    const entry = join(FIXTURES, 'mono-correlated', 'input', 'App.svelte');
    const ts = await tsShake(entry, MONO_ON);
    const native = await nativeShake(entry, MONO_ON);
    expect(native.files).toEqual(ts.files);
    expect(native.variants).toEqual(ts.variants);
    // sanity: monomorphization genuinely produced variants here
    expect(Object.keys(ts.variants).length).toBeGreaterThan(0);
  });

  it('mono off equals the base fold (mono-correlated)', async () => {
    const entry = join(FIXTURES, 'mono-correlated', 'input', 'App.svelte');
    const ts = await tsShake(entry, MONO_OFF);
    const native = await nativeShake(entry, MONO_OFF);
    expect(native.files).toEqual(ts.files);
    expect(native.variants).toEqual({});
  });

  it('folds exponent-boundary numbers with JS `Number#toString`, matching the TS engine', async () => {
    // The native engine turns a folded number back into source via the same
    // `js_number_to_string` as the WASM engine; `format!("{n}")` diverged from JS
    // at the fixed<->exponential cutoffs (`1e21`, `1e-7`). Kept in-memory (not a
    // fixture) so the fresh, locally-built addon is exercised rather than the
    // separately-published binary, which lags this engine change.
    const { resolve, readFile } = memGraph({
      '/App.svelte': `<script>\n  import Sub from './Sub.svelte';\n</script>\n<Sub big={1e21} small={1e-7} plain={1e20} />`,
      '/Sub.svelte':
        `<script>\n  let { big, small, plain } = $props();\n</script>\n` +
        `<p>{big.toLocaleString()} {small.toLocaleString()} {plain.toLocaleString()}</p>`,
    });

    const tsResult = await svelteShakerWithMono(
      '/App.svelte',
      resolve,
      readFile,
      MONO_OFF,
      variantSpecifier,
    );

    const input = await buildAnalyzeInput('/App.svelte', resolve, readFile);
    const session = new addon!.ShakeSession();
    session.parse(JSON.stringify({ files: input.files.map((f) => ({ id: f.id, code: f.code })) }));
    const config = {
      edges: input.edges,
      entries: input.entries,
      escaped: input.escaped ?? [],
      mono: MONO_OFF,
    };
    let native!: Shaken;
    const files = revertCascade(input.files, (forceBail) => {
      native = JSON.parse(
        session.shake(JSON.stringify({ ...config, forceBail: [...forceBail] }), ownSizePayload),
      ) as Shaken;
      return native.files;
    });

    expect(files).toEqual(tsResult.files);
    expect(files['/Sub.svelte']).toContain('(1e+21)');
    expect(files['/Sub.svelte']).toContain('(1e-7)');
    expect(files['/Sub.svelte']).not.toContain('1000000000000000000000'); // the old `format!` bug
  });
});

describe.skipIf(!addon)('native ShakeSession revert / parse-error semantics', () => {
  it('force-bails a component: its output is its untouched original', async () => {
    // The revert cascade's tool is `forceBail`; a bailed component folds nothing, so
    // its emitted source equals its original byte-for-byte (docs REVERT_REASON).
    const { resolve, readFile } = memGraph({
      '/App.svelte': "<script>import Sub from './Sub.svelte';</script>\n<Sub hasIcon={false} />",
      '/Sub.svelte':
        '<script>let { hasIcon = false } = $props();</script>\n{#if hasIcon}<i>x</i>{/if}\n<p>base</p>',
    });
    const input = await buildAnalyzeInput('/App.svelte', resolve, readFile);
    const session = new addon!.ShakeSession();
    session.parse(JSON.stringify({ files: input.files.map((f) => ({ id: f.id, code: f.code })) }));
    const base = {
      edges: input.edges,
      entries: input.entries,
      escaped: input.escaped ?? [],
      mono: MONO_OFF,
    };

    const bailed = JSON.parse(
      session.shake(JSON.stringify({ ...base, forceBail: ['/Sub.svelte'] })),
    ) as Shaken;
    // Force-bailed Sub is untouched...
    expect(bailed.files['/Sub.svelte']).toBe(readFile('/Sub.svelte'));
    // ...and without the bail, Sub folds (the dead `{#if}` arm is removed), so the
    // two differ — confirming the bail actually suppressed a real fold.
    const folded = JSON.parse(session.shake(JSON.stringify(base))) as Shaken;
    expect(folded.files['/Sub.svelte']).not.toBe(bailed.files['/Sub.svelte']);
    expect(folded.files['/Sub.svelte']).not.toContain('hasIcon');
  });

  it('a file that rsvelte cannot parse is flagged parseError, and the JS crawl throws', async () => {
    // A syntactically invalid `.svelte`. The JS `buildAnalyzeInput` (which the native
    // chatty path uses to resolve edges) throws when it reaches the file — so the
    // whole path throws identically. `ShakeSession.parse` never throws; it flags the
    // file `parseError`, the signal the driver turns into the same failure.
    const invalid = '<script>let { a = } = $props()</script>\n{#if}';
    const { resolve, readFile } = memGraph({
      '/App.svelte': "<script>import Bad from './Bad.svelte';</script>\n<Bad />",
      '/Bad.svelte': invalid,
    });
    await expect(buildAnalyzeInput('/App.svelte', resolve, readFile)).rejects.toThrow();

    const session = new addon!.ShakeSession();
    const facts = JSON.parse(
      session.parse(JSON.stringify({ files: [{ id: '/Bad.svelte', code: invalid }] })),
    ) as { files: { id: string; parseError: boolean }[] };
    expect(facts.files[0]!.parseError).toBe(true);
  });
});

describe.skipIf(!addon)('native ShakeSession incremental parseMore (chatty crawl)', () => {
  it('parseMore appends only new files, skipping already-retained ids', () => {
    const a = { id: '/A.svelte', code: "<script>import X from './X.svelte';</script><X />" };
    const b = { id: '/B.svelte', code: '<p>no script</p>' };
    const session = new addon!.ShakeSession();
    session.parse(JSON.stringify({ files: [a] }));
    // Re-send A (must be skipped as already retained) plus the new B.
    const more = JSON.parse(session.parseMore(JSON.stringify({ files: [a, b] }))) as {
      files: { id: string }[];
    };
    // Only B is newly parsed, so only B's facts come back.
    expect(more.files.map((f) => f.id)).toEqual(['/B.svelte']);
  });

  it('parse-all == parse + parseMore rounds (byte-identical shake) across the corpus', async () => {
    for (const entry of entries) {
      const input = await buildAnalyzeInput(entry, fsResolve, fsReadFile);
      if (input.files.length < 2) continue; // nothing to split
      const files = input.files.map((f) => ({ id: f.id, code: f.code }));
      const config = {
        edges: input.edges,
        entries: input.entries,
        escaped: input.escaped ?? [],
        mono: MONO_OFF,
        forceBail: [] as string[],
      };
      // Single-shot parse.
      const one = new addon!.ShakeSession();
      one.parse(JSON.stringify({ files }));
      const single = JSON.parse(one.shake(JSON.stringify(config))) as Shaken;
      // Incremental: split the SAME program-order list; the second round re-includes
      // the first file to exercise the dedup skip. Order of retained files is
      // preserved, so the shake must be byte-identical.
      const mid = Math.max(1, Math.floor(files.length / 2));
      const inc = new addon!.ShakeSession();
      inc.parse(JSON.stringify({ files: files.slice(0, mid) }));
      inc.parseMore(JSON.stringify({ files: [files[0]!, ...files.slice(mid)] }));
      const incremental = JSON.parse(inc.shake(JSON.stringify(config))) as Shaken;
      const label = entry.split('/fixtures/')[1] ?? entry.split('/packages/')[1] ?? entry;
      expect(incremental.files, label).toEqual(single.files);
    }
  });
});

// ---------------------------------------------------------------------------
// Corpus sweep: every golden fixture + example + e2e, with mono ON and OFF.
// ---------------------------------------------------------------------------

const fixtureEntries = readdirSync(FIXTURES, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => join(FIXTURES, d.name, 'input', 'App.svelte'))
  .filter((p) => existsSync(p));

const exampleE2eEntries = [
  fileURLToPath(new URL('../../example/src/App.svelte', import.meta.url)),
  fileURLToPath(new URL('../../e2e/src/App.svelte', import.meta.url)),
].filter((p) => existsSync(p));

const entries = [...fixtureEntries, ...exampleE2eEntries];

describe.skipIf(!addon)('native ShakeSession matches the TS engine across the corpus', () => {
  for (const entry of entries) {
    const label = entry.split('/fixtures/')[1] ?? entry.split('/packages/')[1] ?? entry;
    it(`${label}: files + variants match (mono on & off)`, async () => {
      for (const mono of [MONO_ON, MONO_OFF]) {
        const ts = await tsShake(entry, mono);
        const native = await nativeShake(entry, mono);
        expect(native.files, `${label} files (mono=${mono.enabled})`).toEqual(ts.files);
        expect(native.variants, `${label} variants (mono=${mono.enabled})`).toEqual(ts.variants);
      }
    });
  }
});
