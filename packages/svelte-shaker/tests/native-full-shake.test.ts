import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve as resolvePath } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildAnalyzeInput,
  svelteShakerWithMono,
  type ComponentId,
  type MonomorphizeOptions,
} from '../src/index';
import { revertCascade } from '../src/revert-cascade';
import { tryLoadRsvelteOwnSize } from '../src/rsvelte-parse';
import { fsReadFile, fsResolve } from '../src/scan';
import { loadNativeAddon } from './native-addon';
import { memGraph } from './mem-graph';
import { assertCompiles, cleanTmp } from './diff';

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

afterAll(() => cleanTmp());

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
async function nativeShake(
  entry: ComponentId | ComponentId[],
  mono: MonomorphizeOptions,
  resolve = fsResolve,
  readFile = fsReadFile,
): Promise<Shaken> {
  const input = await buildAnalyzeInput(entry, resolve, readFile);
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

/**
 * Both engines over an in-memory graph, the shape the regression cases below need.
 * In-memory (rather than a golden fixture) so the FRESH, locally-built addon is
 * exercised — the separately-published binary lags engine changes — and asserts the
 * byte-identity up front, so each case only has to state what it additionally pins.
 */
async function bothOverGraph(
  files: Record<string, string>,
  entry: ComponentId | ComponentId[],
  mono: MonomorphizeOptions = MONO_OFF,
): Promise<Shaken> {
  const { resolve, readFile } = memGraph(files);
  const result = await svelteShakerWithMono(
    entry,
    resolve,
    readFile,
    mono,
    variantSpecifier,
    undefined,
    undefined,
    ownSize,
  );
  const tsVariants: Record<string, string> = {};
  for (const v of result.mono.variants.values()) tsVariants[variantSpecifier(v.id)] = v.code;

  const native = await nativeShake(entry, mono, resolve, readFile);
  expect(native.files).toEqual(result.files);
  expect(native.variants).toEqual(tsVariants);
  for (const [id, code] of Object.entries(native.files)) assertCompiles(code, id);
  return native;
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
    // A folded number is turned back into source by the engine's
    // `js_number_to_string`. `format!("{n}")` diverges from JS at the spec's
    // fixed<->exponential cutoffs (`1e21 -> "1e+21"`, `1e-7 -> "1e-7"`), which would
    // emit a DIFFERENT number than the unshaken component renders. Passed as members
    // so they land in source text (`(1e+21).toLocaleString()`).
    const { files } = await bothOverGraph(
      {
        '/App.svelte': `<script>\n  import Sub from './Sub.svelte';\n</script>\n<Sub big={1e21} small={1e-7} tiny={1e-6} plain={1e20} />`,
        '/Sub.svelte':
          `<script>\n  let { big, small, tiny, plain } = $props();\n</script>\n` +
          `<p>{big.toLocaleString()} {small.toLocaleString()} {tiny.toLocaleString()} {plain.toLocaleString()}</p>`,
      },
      '/App.svelte',
    );
    expect(files['/Sub.svelte']).toContain('(1e+21)');
    expect(files['/Sub.svelte']).toContain('(1e-7)');
    expect(files['/Sub.svelte']).toContain('(0.000001)'); // just above the cutoff: no exponent
    expect(files['/Sub.svelte']).not.toContain('1000000000000000000000'); // the old `format!` bug
  });

  it('folds a >17-significant-digit literal correctly (parse-side rounding, issue #178)', async () => {
    // serde_json mis-rounds `123456789012345680000` by one ULP; the engine now
    // re-parses the literal's `raw` source with Rust's correctly-rounded
    // `str::parse::<f64>`, so it folds the same decimal as the TS engine.
    const { files } = await bothOverGraph(
      {
        '/App.svelte': `<script>\n  import Sub from './Sub.svelte';\n</script>\n<Sub n={123456789012345680000} />`,
        '/Sub.svelte': `<script>\n  let { n } = $props();\n</script>\n<p>{n.toLocaleString()}</p>`,
      },
      '/App.svelte',
    );
    expect(files['/Sub.svelte']).toContain('(123456789012345680000)');
    expect(files['/Sub.svelte']).not.toContain('123456789012345670000');
  });

  it('drops every dropped prop from an inline `$props()` type, even overlapping members', async () => {
    // `remove_type_member` emits `[a.start, b.start)` then `[a.end, b.end)` when it
    // drops the LAST type member whose predecessor is also dropped — two OVERLAPPING
    // removes. magic-string (the TS engine) unions them, so both members go; the
    // native `MagicEdit` used to keep the earlier one, leaving `urgent?: boolean`
    // behind and diverging from TS. `label` stays (dynamic), so the `$props()` line
    // survives and the type-member path actually runs.
    const { files } = await bothOverGraph(
      {
        '/App.svelte': `<script lang="ts">\n  import Sub from './Sub.svelte';\n  let n = Math.random();\n</script>\n<Sub label={n} />`,
        '/Sub.svelte':
          `<script lang="ts">\n  let { label, urgent = false, variant = 'info' }: ` +
          `{ label?: number; urgent?: boolean; variant?: string } = $props();\n</script>\n` +
          `{#if urgent}<strong>!</strong>{/if}\n<p class="alert alert-{variant}">{label}</p>`,
      },
      '/App.svelte',
    );
    // The dropped members are gone; the kept one stays.
    expect(files['/Sub.svelte']).toContain('label?: number');
    expect(files['/Sub.svelte']).not.toContain('urgent?: boolean');
    expect(files['/Sub.svelte']).not.toContain('variant?: string');
  });

  it('edits non-ASCII source at UTF-16 offsets, matching the TS engine', async () => {
    // Multibyte text before/after the folded branch would corrupt a byte-indexed
    // editor; `MagicEdit` counts UTF-16 units, so it must match the TS engine exactly.
    const { files } = await bothOverGraph(
      {
        '/App.svelte': `<script>\n  import Sub from './Sub.svelte';\n</script>\n<Sub />`,
        '/Sub.svelte': `<script>\n  let { hasIcon = false } = $props();\n</script>\n<p>こんにちは🌟</p>\n{#if hasIcon}<p>アイコン</p>{/if}\n<p>さようなら</p>`,
      },
      '/App.svelte',
    );
    // The dead `{#if}` (アイコン) is gone; the surrounding multibyte text survives intact.
    expect(files['/Sub.svelte']).toContain('こんにちは🌟');
    expect(files['/Sub.svelte']).toContain('さようなら');
    expect(files['/Sub.svelte']).not.toContain('アイコン');
  });

  it('does not fold a TS interface-member key', async () => {
    // Mirrors transform-robustness's interface-key guard: the engine's
    // `is_non_reference` must skip a `TSPropertySignature` key, or it would corrupt
    // `width?: number` -> `36?: number` and diverge from the TS engine.
    const { files } = await bothOverGraph(
      {
        '/App.svelte': `<script lang="ts">\n  import Child from './Child.svelte';\n</script>\n<Child />`,
        '/Child.svelte': `<script lang="ts">\n  interface Props {\n    width?: number;\n    height?: number;\n  }\n  const { width = 36, height = 20 }: Props = $props();\n</script>\n<p>{width}{height}</p>`,
      },
      '/App.svelte',
    );
    expect(files['/Child.svelte']).toContain('width?: number');
    expect(files['/Child.svelte']).not.toContain('36?: number');
  });

  it('folds through TS assertions identically to the TS engine (issue #150)', async () => {
    // svelte/compiler keeps `'chips' as const` / `8 as const` as TS assertion nodes,
    // so the engine sees them too. Its evaluator (call-site value) and its
    // `literal_default` (never-passed default) must both read through the erased
    // assertion exactly like the TS engine, or the two byte-diverge on `lang="ts"`
    // apps. `pattern` folds from the call site; `size` from its `as const` default.
    const { files } = await bothOverGraph(
      {
        '/App.svelte': `<script lang="ts">\n  import Child from './Child.svelte';\n</script>\n<Child pattern={'chips' as const} />`,
        '/Child.svelte':
          `<script lang="ts">\n  let { pattern, size = 8 as const } = $props();\n</script>\n` +
          `{#if pattern === 'text'}<em>t</em>{/if}\n{#if pattern === 'chips'}<b>c</b>{/if}\n` +
          `{#if size === 8}<i>eight</i>{/if}`,
      },
      '/App.svelte',
    );
    const child = files['/Child.svelte']!;
    expect(child).toContain('<b>c</b>'); // pattern folded from the call site
    expect(child).toContain('<i>eight</i>'); // size folded from its `as const` default
    expect(child).not.toContain('<em>'); // dead `pattern === 'text'` arm removed
    expect(child).not.toContain('pattern'); // both props dropped from the signature
  });

  it('sees a write made through a TS assertion target (issue #183)', async () => {
    // `count!++` / `count! += 1` are writes, so `count` is not a constant and
    // nothing may fold. rsvelte used to serialize a TS-wrapped assignment target
    // as `null`, hiding the write from `collect_written`, so the native engine
    // folded `n` to `0` and the counter froze on screen — a soundness break the
    // TS engine (svelte/compiler's AST) never had.
    const { files } = await bothOverGraph(
      {
        '/App.svelte':
          `<script lang="ts">\n  import Child from './Child.svelte';\n  let count = $state(0);\n  let step = $state(1);\n` +
          `  function inc() { count!++; step! += 1; }\n</script>\n` +
          `<Child n={count} s={step} /><button onclick={inc}>+</button>`,
        '/Child.svelte': `<script lang="ts">\n  let { n, s } = $props();\n</script>\n<p>{n}/{s}</p>`,
      },
      '/App.svelte',
    );
    // Both props survive: neither call-site value is provably constant.
    expect(files['/Child.svelte']).toContain('let { n, s } = $props();');
    expect(files['/Child.svelte']).toContain('<p>{n}/{s}</p>');
    expect(files['/App.svelte']).toContain('<Child n={count} s={step} />');
  });

  it('matches the TS engine on an interprocedural pass-through (docs §13.1)', async () => {
    // App -> Mid -> Child: `variant` folds in Mid, so the forwarded
    // `<Child variant={variant}/>` must fold in Child too and its attribute be
    // removed. The fixpoint's owner-env evaluation must match the TS engine
    // byte-for-byte — including a ternary and a pure-literal forward.
    const { files } = await bothOverGraph(
      {
        '/App.svelte': `<script>\n  import Mid from './Mid.svelte';\n</script>\n<Mid variant="primary" />`,
        '/Mid.svelte':
          `<script>\n  import Child from './Child.svelte';\n  import Leaf from './Leaf.svelte';\n  let { variant } = $props();\n</script>\n` +
          `<Child variant={variant} />\n<Leaf k={variant === 'primary' ? 'x' : 'y'} m={'a' + 'b'} />`,
        '/Child.svelte':
          `<script>\n  let { variant = 'other' } = $props();\n</script>\n` +
          `{#if variant === 'primary'}<b>P</b>{:else}<i>o</i>{/if}`,
        '/Leaf.svelte':
          `<script>\n  let { k = 'z', m = 'z' } = $props();\n</script>\n` +
          `{#if k === 'x'}<b>X</b>{/if}{#if m === 'ab'}<b>AB</b>{/if}`,
      },
      '/App.svelte',
    );
    // The pass-through actually fired (both engines agree on this, in the helper).
    expect(files['/Child.svelte']).not.toMatch(/let \{ variant/);
    expect(files['/Mid.svelte']).not.toContain('variant=');
    expect(files['/Leaf.svelte']).not.toMatch(/let \{ k/);
  });

  it('propagates a deep pass-through chain past the old fixpoint cap', async () => {
    // A 14-stage forwarding chain needs more propagation rounds than the old fixed
    // cap of 10. Both engines scale the fixpoint bound with the component count, so
    // the deepest fold (S14) must reach the leaf identically — byte-for-byte.
    const graph: Record<string, string> = {
      '/App.svelte': `<script>\n  import S1 from './S1.svelte';\n</script>\n<S1 v="go" />\n`,
    };
    for (let k = 1; k < 14; k++) {
      graph[`/S${k}.svelte`] =
        `<script>\n  import S${k + 1} from './S${k + 1}.svelte';\n  let { v } = $props();\n</script>\n` +
        `<S${k + 1} v={v} />\n`;
    }
    graph['/S14.svelte'] =
      `<script>\n  let { v = 'stop' } = $props();\n</script>\n` +
      `{#if v === 'go'}<b>GO</b>{:else}<i>stop</i>{/if}\n`;

    const { files } = await bothOverGraph(graph, '/App.svelte');
    // The fold reached the leaf in both engines: dead arm gone, prop dropped.
    expect(files['/S14.svelte']).toContain('<b>GO</b>');
    expect(files['/S14.svelte']).not.toContain('stop</i>');
    expect(files['/S14.svelte']).not.toMatch(/let \{ v/);
  });
});

describe.skipIf(!addon)('native ShakeSession under a changing file set', () => {
  it('stays byte-identical to the TS engine across an edit/add/remove sequence', async () => {
    // The whole-program cascade must re-converge when the FILE SET moves, not just
    // when a file's contents do: a new caller passing a different value un-shakes a
    // child, and removing it re-shakes. A build re-runs the crawl and a fresh
    // ShakeSession per build, so that is what this drives — one session per step.
    const APP_NO_ICON = `<script>\n  import Sub from './Sub.svelte';\n</script>\n<Sub />`;
    const APP_ICON = `<script>\n  import Sub from './Sub.svelte';\n</script>\n<Sub hasIcon={true} />`;
    const APP_NO_SUB = `<script>\n  import Sub from './Sub.svelte';\n</script>\n<p>hi</p>`;
    const SUB = `<script>\n  let { hasIcon = false } = $props();\n</script>\n{#if hasIcon}<p>Icon</p>{/if}\n<p>base</p>`;
    const OTHER = `<script>\n  import Sub from './Sub.svelte';\n</script>\n<Sub hasIcon={false} />`;

    const graph: Record<string, string> = { '/App.svelte': APP_NO_ICON, '/Sub.svelte': SUB };
    // Every `.svelte` in the set is an entry, so a file reachable from nothing (an
    // orphaned `/Other.svelte`) still contributes its call sites — as in a real crawl.
    const step = async (): Promise<Shaken> =>
      bothOverGraph(
        graph,
        Object.keys(graph).filter((f) => f.endsWith('.svelte')),
      );

    // init: hasIcon never passed -> folded -> Icon removed.
    expect((await step()).files['/Sub.svelte']).not.toContain('Icon');

    // edit a call site: App passes hasIcon={true} -> Sub keeps Icon.
    graph['/App.svelte'] = APP_ICON;
    expect((await step()).files['/Sub.svelte']).toContain('Icon');

    // add a file passing a different value -> {true,false} -> Sub un-shakes.
    graph['/Other.svelte'] = OTHER;
    expect((await step()).files['/Sub.svelte']).toContain('hasIcon');

    // remove it -> single `true` site -> folds again.
    delete graph['/Other.svelte'];
    expect((await step()).files['/Sub.svelte']).toContain('Icon');

    // edit a leaf's own markup.
    graph['/Sub.svelte'] = SUB.replace('<p>base</p>', '<p>BASE</p>');
    expect((await step()).files['/Sub.svelte']).toContain('BASE');

    // drop the usage entirely -> Sub left untouched.
    graph['/App.svelte'] = APP_NO_SUB;
    expect((await step()).files['/Sub.svelte']).toContain('hasIcon');
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
