import { describe, expect, it } from 'vitest';
import {
  analyzeInput,
  buildAnalyzeInput,
  svelteShaker,
  transformAll,
  type AnalyzeInput,
} from '../src/index';

// ----------------------------------------------------------------------
// M1 boundary regression (docs/RUST-MIGRATION.md §2).  The engine was split into
//   buildAnalyzeInput(entries, resolve, readFile)  -> AnalyzeInput   (Shell side)
//   analyzeInput(AnalyzeInput)                      -> models/plans   (pure engine)
// with `svelteShaker` = transformAll(analyzeInput(await buildAnalyzeInput(…))).
//
// Two properties must hold so the engine can later be a Rust process behind napi:
//  1. AnalyzeInput is plain data — a JSON round-trip is identity (only source
//     strings + the resolved graph cross the boundary; no ASTs, no closures).
//  2. Running the engine on the (round-tripped) batched input is byte-for-byte
//     identical to the convenience `svelteShaker` path.
// ----------------------------------------------------------------------

/** Minimal in-memory module graph (POSIX-style absolute ids). */
function memGraph(files: Record<string, string>): {
  resolve: (source: string, importer: string) => string | null;
  readFile: (id: string) => string;
} {
  const resolve = (source: string, importer: string): string | null => {
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
  const readFile = (id: string): string => {
    const code = files[id];
    if (code === undefined) throw new Error(`no such file: ${id}`);
    return code;
  };
  return { resolve, readFile };
}

/** App -> Sub where Sub folds a never-passed prop (the basic1 shape) + a barrel
 * re-export, so the input exercises both `default-svelte` and `barrel` edges. */
const FILES: Record<string, string> = {
  '/App.svelte': `<script lang="ts">
  import Sub from './Sub.svelte';
  import { Lib } from './lib.js';
</script>
<Sub />
<Lib msg="hi" />`,
  '/Sub.svelte': `<script lang="ts">
  let { hasIcon = false }: { hasIcon: boolean } = $props();
</script>
{#if hasIcon}<p>Icon</p>{/if}
<p>base</p>`,
  '/lib.js': `export { default as Lib } from './Lib.svelte';`,
  '/Lib.svelte': `<script lang="ts">
  let { msg }: { msg: string } = $props();
</script>
<p>{msg}</p>`,
};

describe('M1 batched engine boundary', () => {
  it('AnalyzeInput is JSON-serializable (round-trip is identity)', async () => {
    const { resolve, readFile } = memGraph(FILES);
    const input = await buildAnalyzeInput('/App.svelte', resolve, readFile);
    const roundtripped: AnalyzeInput = JSON.parse(JSON.stringify(input));
    expect(roundtripped).toEqual(input);
  });

  it('carries the resolved graph: a default-svelte edge AND a barrel edge', async () => {
    const { resolve, readFile } = memGraph(FILES);
    const { edges, files } = await buildAnalyzeInput('/App.svelte', resolve, readFile);

    expect(edges).toContainEqual({
      from: '/App.svelte',
      local: 'Sub',
      to: '/Sub.svelte',
      kind: 'default-svelte',
    });
    expect(edges).toContainEqual({
      from: '/App.svelte',
      local: 'Lib',
      to: '/Lib.svelte',
      kind: 'barrel',
    });
    // The barrel `.js` is consumed during resolution; only `.svelte` files are
    // modeled by the engine.
    const ids = files.map((f) => f.id).sort();
    expect(ids).toEqual(['/App.svelte', '/Lib.svelte', '/Sub.svelte']);
  });

  it('running the engine on the batched input equals svelteShaker (byte-identical)', async () => {
    const { resolve, readFile } = memGraph(FILES);

    const input = await buildAnalyzeInput('/App.svelte', resolve, readFile);
    const roundtripped: AnalyzeInput = JSON.parse(JSON.stringify(input));
    const { models, plans } = analyzeInput(roundtripped);
    const viaBatch = transformAll(models, plans);

    const viaShaker = await svelteShaker('/App.svelte', resolve, readFile);

    expect(viaBatch).toEqual(viaShaker);

    // Sanity: the shake actually happened (otherwise the equality is vacuous) —
    // the never-passed `hasIcon` is folded away and dropped from the signature.
    expect(viaShaker['/Sub.svelte']).not.toContain('hasIcon');
    expect(viaShaker['/Sub.svelte']).not.toContain('Icon');
  });
});
