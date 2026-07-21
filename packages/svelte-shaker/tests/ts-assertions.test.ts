import { afterAll, describe, expect, it } from 'vitest';
import {
  analyzeInput,
  buildAnalyzeInput,
  svelteShaker,
  svelteShakerWithMono,
  transformAll,
  type ReadFile,
  type Resolve,
  type ShakeResult,
} from '../src/index';
import { analyze } from '../src/analyze';
import type { ParseCache } from '../src/parse';
import { rsvelteParse } from './rsvelte-parse';
import { assertCompiles, cleanTmp, renderGraphHtml } from './diff';

const MONO_ON = { enabled: true, maxVariants: 8, minSavings: 0 } as const;

afterAll(() => cleanTmp());

// ----------------------------------------------------------------------
// TypeScript assertion expressions at call sites and in owner-local consts /
// prop defaults (issue #150).
//
// `x as T`, `x!`, `x satisfies T` are compile-time-only type operators: they
// erase to their operand at runtime.  svelte/compiler keeps them in a
// `<script lang="ts">` AST; the rsvelte parser strips them today.  Before the
// fix, `pattern={'chips' as const}` folded on the rsvelte path but NOT on the
// svelte path, so the two parsers shook the SAME app differently — a
// parser-neutrality violation.  The evaluator now reads through the assertions,
// so BOTH paths fold identically.
//
// Every positive case is asserted three ways: (1) the svelte and rsvelte parser
// paths shake byte-identically, (2) the intended fold actually happened, and (3)
// the whole graph server-renders identical HTML before/after (the soundness
// oracle).  The parity claim holds for today's rsvelte (which strips the node)
// AND a future rsvelte that preserves it — the engine unwrap makes both true.
// ----------------------------------------------------------------------

/** Minimal in-memory module graph for the engine (POSIX-style absolute ids). */
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

/** Shake from `/App.svelte` driving the engine with the rsvelte parser (via the
 * ParseCache seam), instead of svelte/compiler. */
async function shakeWithRsvelte(files: Record<string, string>): Promise<Record<string, string>> {
  const { resolve, readFile } = memGraph(files);
  const input = await buildAnalyzeInput('/App.svelte', resolve, readFile);
  const cache: ParseCache = new Map();
  for (const f of input.files) cache.set(f.id, { code: f.code, ast: rsvelteParse(f.code) });
  const { models, plans } = analyzeInput(input, cache);
  return transformAll(models, plans);
}

/** Shake with svelte/compiler AND rsvelte; assert byte-identical output; return
 * the svelte-path result. */
async function bothParsers(files: Record<string, string>): Promise<Record<string, string>> {
  const { resolve, readFile } = memGraph(files);
  const viaSvelte = await svelteShaker('/App.svelte', resolve, readFile);
  const viaRsvelte = await shakeWithRsvelte(files);
  expect(viaRsvelte).toEqual(viaSvelte);
  return viaSvelte;
}

/** Render the whole `/App.svelte` graph (flat `/X.svelte` ids) to HTML. */
async function graphHtml(files: Record<string, string>): Promise<string> {
  const deps: Record<string, string> = {};
  for (const [id, src] of Object.entries(files)) {
    if (id === '/App.svelte') continue;
    deps[`.${id}`] = src; // `/Child.svelte` -> `./Child.svelte`
  }
  return renderGraphHtml({ specifier: './App.svelte', source: files['/App.svelte']! }, deps, {});
}

/** Assert the whole graph renders identical HTML before/after shaking (the
 * soundness oracle) and every shaken file still compiles. */
async function shakeSound(files: Record<string, string>): Promise<void> {
  const { resolve, readFile } = memGraph(files);
  const out = await svelteShaker('/App.svelte', resolve, readFile);
  for (const [id, src] of Object.entries(out))
    assertCompiles(src, id.slice(id.lastIndexOf('/') + 1));
  const before = await graphHtml(files);
  const after = await graphHtml({ ...files, ...out });
  expect(after).toBe(before);
}

describe('TypeScript assertions at call sites fold parser-neutrally (issue #150)', () => {
  it("the issue repro: `pattern={'chips' as const}` folds identically under both parsers", async () => {
    const files = {
      '/App.svelte':
        `<script lang="ts">\n  import Child from './Child.svelte';\n</script>\n` +
        `<Child label="x" pattern={'chips' as const} />\n`,
      '/Child.svelte':
        `<script lang="ts">\n  let { label, pattern } = $props();\n</script>\n` +
        `<span>{label}</span>\n` +
        `{#if pattern === 'text'}<em>text</em>{/if}\n` +
        `{#if pattern === 'chips'}<b>chips</b>{/if}\n`,
    };
    // The owner const-folds `pattern` to 'chips', so `Child` sees a singleton set.
    const { plans } = await analyze('/App.svelte', ...toArgs(files));
    expect(plans.get('/Child.svelte')!.constFold.get('pattern')).toBe('chips');

    const viaSvelte = await bothParsers(files);
    const child = viaSvelte['/Child.svelte']!;
    expect(child).not.toContain("=== 'text'"); // dead arm removed
    expect(child).not.toContain('<em>'); // its body gone
    expect(child).toContain('<b>chips</b>'); // proven-true arm kept
    expect(child).not.toContain('pattern'); // prop dropped from the signature
    expect(viaSvelte['/App.svelte']!).not.toContain('as const'); // attribute removed whole

    await shakeSound(files);
  });

  it('owner-local `const MAX = 500 as const` folds to the child under both parsers', async () => {
    const files = {
      '/App.svelte':
        `<script lang="ts">\n  import Gauge from './Gauge.svelte';\n  const MAX = 500 as const;\n</script>\n` +
        `<Gauge max={MAX} />\n`,
      '/Gauge.svelte':
        `<script lang="ts">\n  let { max } = $props();\n</script>\n` +
        `{#if max === 500}<b>full</b>{:else}<i>{max}</i>{/if}\n`,
    };
    const viaSvelte = await bothParsers(files);
    const gauge = viaSvelte['/Gauge.svelte']!;
    expect(gauge).toContain('<b>full</b>'); // `max === 500` proven true
    expect(gauge).not.toContain('<i>'); // else arm removed
    await shakeSound(files);
  });

  it('a prop default `= 500 as const` folds when the prop is never passed (both parsers)', async () => {
    const files = {
      '/App.svelte':
        `<script lang="ts">\n  import Gauge from './Gauge.svelte';\n</script>\n` + `<Gauge />\n`,
      '/Gauge.svelte':
        `<script lang="ts">\n  let { max = 500 as const } = $props();\n</script>\n` +
        `{#if max === 500}<b>full</b>{:else}<i>{max}</i>{/if}\n`,
    };
    const viaSvelte = await bothParsers(files);
    const gauge = viaSvelte['/Gauge.svelte']!;
    expect(gauge).toContain('<b>full</b>'); // default 500 folded through `as const`
    expect(gauge).not.toContain('<i>');
    await shakeSound(files);
  });
});

/** Spread the memGraph resolve/readFile as positional args for `analyze`. */
function toArgs(files: Record<string, string>): [Resolve, ReadFile] {
  const { resolve, readFile } = memGraph(files);
  return [resolve, readFile];
}

async function analyzeFiles(files: Record<string, string>) {
  return analyze('/App.svelte', ...toArgs(files));
}

// ----------------------------------------------------------------------
// A `!` non-null assertion on an assignment / update TARGET keeps the
// `TSNonNullExpression` wrapper in every position but a bare `x = …` LHS (verified
// against svelte/compiler): `x!++`, `x! += 1`, `[x!] = a`, `({ k: x! } = o)`. If
// the write-collection misses it, the written binding is wrongly admitted as a
// constant and a stale value folds — an invariant break. The unwrap in
// `collectWrittenNames` / `addPatternNames` closes each shape.
// ----------------------------------------------------------------------
describe('writes through a `!` non-null assertion still count as writes (issue #150 review)', () => {
  const shapes: Array<[string, string]> = [
    ['x!++', 'x!++;'],
    ['x! += 1', 'x! += 1;'],
    ['[x!] = arr', '[x!] = [1];'],
    ['({ k: x! } = obj)', '({ k: x! } = { k: 1 });'],
  ];
  for (const [label, write] of shapes) {
    it(`\`${label}\` marks the owner binding written, so it is not folded`, async () => {
      const files = {
        '/App.svelte':
          `<script lang="ts">\n  import C from './C.svelte';\n  let x = $state(0);\n  function bump() { ${write} }\n</script>\n` +
          `<C n={x} />\n<button onclick={bump}>+</button>\n`,
        '/C.svelte':
          `<script lang="ts">\n  let { n } = $props();\n</script>\n` +
          `{#if n === 0}<b>zero</b>{:else}<i>{n}</i>{/if}\n`,
      };
      const { models, plans } = await analyzeFiles(files);
      // Written -> NOT admitted as an owner constant -> the child prop stays dynamic.
      expect(models.get('/App.svelte')!.scriptConstEnv.has('x')).toBe(false);
      expect(plans.get('/C.svelte')!.constFold.has('n')).toBe(false);
      await shakeSound(files); // still sound (nothing folded on a stale value)
    });
  }
});

// ----------------------------------------------------------------------
// Monomorphization reads `explicit.dynamic` in `specializableShape`. Before the
// `literalAttrValue` unwrap, `a={0 as const}` was `dynamic:true` on the svelte
// path but `dynamic:false` on the rsvelte path, so the correlated `{#if}` folded
// (and Heavy was eliminated) on ONE parser only — the two disagreed on whether to
// specialize. With the source-level unwrap both classify it as a literal.
// ----------------------------------------------------------------------
describe('monomorphization specializes identically under both parsers (issue #150 review)', () => {
  it('a correlated-condition site passed `as const` specializes the same on both parsers', async () => {
    const heavyBody =
      '<div class="heavy">' +
      Array.from({ length: 40 }, (_, i) => `<span>heavy widget cell ${i}</span>`).join('') +
      '</div>';
    const files: Record<string, string> = {
      // `a`/`b` are app-wide multi-valued, so only monomorphization can kill the
      // correlated `{#if a===1 && b===1}`. The critical frozen value at each site
      // is passed via `as const`, so specialization hinges on the assertion being
      // recognized as a literal.
      '/App.svelte':
        `<script lang="ts">\n  import Child from './Child.svelte';\n</script>\n` +
        `<Child a={0 as const} b={1} />\n<Child a={1} b={0 as const} />\n`,
      '/Child.svelte':
        `<script lang="ts">\n  import Heavy from './Heavy.svelte';\n  let { a, b } = $props();\n</script>\n` +
        `{#if a === 1 && b === 1}<Heavy />{/if}<p>base</p>\n`,
      '/Heavy.svelte': `<script lang="ts">\n  let { n = 0 } = $props();\n</script>\n${heavyBody}\n`,
    };
    const { resolve, readFile } = memGraph(files);
    const viaSvelte = await svelteShakerWithMono('/App.svelte', resolve, readFile, MONO_ON);
    const viaRsvelte = await svelteShakerWithMono(
      '/App.svelte',
      resolve,
      readFile,
      MONO_ON,
      undefined,
      rsvelteParse,
    );
    expect(monoProjection(viaRsvelte)).toEqual(monoProjection(viaSvelte));
    // Specialization actually fired (both sites), so the parity assertion is
    // load-bearing rather than "both did nothing".
    expect(viaSvelte.mono.bindings.length).toBe(2);
    for (const v of viaSvelte.mono.variants.values()) expect(v.code).not.toContain('<Heavy');
  });
});

// ----------------------------------------------------------------------
// `const x = $state(0) as T` wraps the rune in a `TSAsExpression`, so the rune
// detection in `evalDeclaratorValue` must see through it or the owner const is not
// admitted on the svelte path (it is on the stripping rsvelte path).
// ----------------------------------------------------------------------
describe('owner-local `$state(...) as T` is still recognized as a rune (issue #150 review)', () => {
  it('`const N = $state(500) as const` folds to the child under both parsers', async () => {
    const files = {
      '/App.svelte':
        `<script lang="ts">\n  import Gauge from './Gauge.svelte';\n  const N = $state(500) as const;\n</script>\n` +
        `<Gauge max={N} />\n`,
      '/Gauge.svelte':
        `<script lang="ts">\n  let { max } = $props();\n</script>\n` +
        `{#if max === 500}<b>full</b>{:else}<i>{max}</i>{/if}\n`,
    };
    const { models } = await analyzeFiles(files);
    expect(models.get('/App.svelte')!.scriptConstEnv.get('N')).toBe(500);
    const viaSvelte = await bothParsers(files);
    expect(viaSvelte['/Gauge.svelte']!).toContain('<b>full</b>');
    expect(viaSvelte['/Gauge.svelte']!).not.toContain('<i>');
    await shakeSound(files);
  });
});

/** A parser-comparable view of a mono shake: the wired owner files plus each
 * variant's residual code (raw AST nodes on `bindings` differ by object identity
 * across parsers, so compare the observable code, not the node handles). */
function monoProjection(r: ShakeResult): { files: Record<string, string>; variants: string[] } {
  return {
    files: r.files,
    variants: [...r.mono.variants].map(([id, v]) => `${id}\n${v.code}`).sort(),
  };
}
