import { join, resolve as resolvePath } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  analyzeInput,
  buildAnalyzeInput,
  type ReadFile,
  type ResolvedEdge,
  type Resolve,
} from '../src/index';
import { parseSvelte } from '../src/parse';
import { fsReadFile, fsResolve } from '../src/scan';

// ----------------------------------------------------------------------
// M4 (docs/RUST-MIGRATION.md M4): the analysis is being ported to a
// self-contained Rust→WASM core (`engine-rs/`), one slice at a time.  Each ported
// piece is validated against the TS engine on the SAME AST + resolved edges, so
// it's logic-vs-logic (the Rust walker reproduces analyze.ts exactly).  Ported so
// far — the WHOLE per-file `FileModel`: declared props, `...rest`, the shadowed /
// `{@debug}` fold-blocking names, the `<svelte:options>` bail, the rendered child
// calls, barrel-rendered children, and escaped components.
// ----------------------------------------------------------------------

const require = createRequire(import.meta.url);
// `wasm-pack --target nodejs` output: a CommonJS module that loads the wasm
// synchronously, so it's a plain require with no init dance.
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports
const wasm = require('../engine-rs/pkg/svelte_shaker_engine.js') as {
  analyze_component: (astJson: string, edgesJson: string) => string;
};

interface ChildCall {
  childId: string;
  start: number;
  end: number;
}
interface ComponentFacts {
  props: string[];
  hasRestProp: boolean;
  shadowed: string[];
  debug: string[];
  bail: string[];
  childCalls: ChildCall[];
  barrelChildIds: string[];
  escaped: string[];
}

const byStart = (a: ChildCall, b: ChildCall): number => a.start - b.start;

function rustFacts(code: string, id: string, edges: ResolvedEdge[]): ComponentFacts {
  const astJson = JSON.stringify(parseSvelte(code, id));
  const out = JSON.parse(wasm.analyze_component(astJson, JSON.stringify(edges))) as ComponentFacts;
  out.childCalls.sort(byStart);
  return out;
}

/** The same per-file model facts the TS engine derives, from an analyzed graph. */
function tsFacts(
  id: string,
  models: Awaited<ReturnType<typeof analyzeGraph>>['models'],
): ComponentFacts {
  const model = models.get(id)!;
  return {
    props: (model.props ?? []).map((p) => p.name),
    hasRestProp: model.hasRestProp,
    shadowed: [...model.shadowedNames].sort(),
    debug: [...model.debugNames].sort(),
    // The Rust slice covers only the accessors/customElement bail so far.
    bail: model.bailReasons.filter((r) => r.startsWith('<svelte:options')),
    childCalls: model.childCalls
      .map((c) => ({ childId: c.childId, start: c.node.start, end: c.node.end }))
      .sort(byStart),
    barrelChildIds: [...model.barrelChildIds].sort(),
    escaped: [...model.escapedComponents].sort(),
  };
}

async function analyzeGraph(entry: string, resolve: Resolve, readFile: ReadFile) {
  const input = await buildAnalyzeInput(entry, resolve, readFile);
  const { models } = analyzeInput(input);
  const edgesByFrom = new Map<string, ResolvedEdge[]>();
  for (const e of input.edges)
    (edgesByFrom.get(e.from) ?? edgesByFrom.set(e.from, []).get(e.from)!).push(e);
  return { input, models, edgesByFrom };
}

/** Assert the Rust per-file facts match the TS engine for every file in a graph. */
async function expectGraphMatches(
  entry: string,
  resolve: Resolve,
  readFile: ReadFile,
): Promise<void> {
  const { input, models, edgesByFrom } = await analyzeGraph(entry, resolve, readFile);
  for (const f of input.files) {
    expect(rustFacts(f.code, f.id, edgesByFrom.get(f.id) ?? []), f.id).toEqual(
      tsFacts(f.id, models),
    );
  }
}

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

const FIXTURES = resolvePath(__dirname, 'fixtures');

describe('M4: Rust (WASM) per-file analysis matches the TS engine', () => {
  // Sweep every fixture's real component graph (with resolved edges).
  for (const name of [
    'basic1',
    'cascade',
    'css-variant',
    'fold-nested',
    'fold-ternary',
    'if-true',
    'narrow-variant',
    'rest-prop',
    'spread-after',
  ]) {
    it(`${name}: full FileModel across the graph`, async () => {
      await expectGraphMatches(join(FIXTURES, name, 'input', 'App.svelte'), fsResolve, fsReadFile);
    });
  }

  it('every binder kind on a real Svelte AST', async () => {
    const files = {
      '/B.svelte': [
        `<script>`,
        `  let { variant } = $props();`,
        `  function handle(evt, ctx) { return evt; }`,
        `  const arr = [1];`,
        `</script>`,
        `{#each arr as { id }, i}<p>{id}{i}</p>{/each}`,
        `{#snippet row(p, q)}<span>{p}{q}</span>{/snippet}`,
        `{#await arr then value}<i>{value}</i>{:catch err}<b>{err}</b>{/await}`,
        `{@const doubled = variant}`,
        `{@debug variant}`,
      ].join('\n'),
    };
    const { resolve, readFile } = memGraph(files);
    await expectGraphMatches('/B.svelte', resolve, readFile);
  });

  it('escape: a component read as a value is flagged identically to the TS engine', async () => {
    const files = {
      '/App.svelte': `<script>\n  import Child from './Child.svelte';\n  const alias = Child;\n</script>\n<svelte:component this={alias} />`,
      '/Child.svelte': `<script>\n  let { x = 1 } = $props();\n</script>\n<p>{x}</p>`,
    };
    const { resolve, readFile } = memGraph(files);
    const { models, edgesByFrom } = await analyzeGraph('/App.svelte', resolve, readFile);
    // Child escapes (assigned to a value), so the App-side analysis records it.
    expect(
      rustFacts(files['/App.svelte'], '/App.svelte', edgesByFrom.get('/App.svelte') ?? []).escaped,
    ).toContain('/Child.svelte');
    await expectGraphMatches('/App.svelte', resolve, readFile);
    expect([...models.get('/App.svelte')!.escapedComponents]).toContain('/Child.svelte');
  });
});
