import { describe, expect, it } from 'vitest';
import {
  buildAnalyzeInput,
  buildAnalyzeInputSync,
  type ReadFile,
  type ReadFileSync,
  type Resolve,
  type ResolveSync,
} from '../src/index';

// `buildAnalyzeInputSync` must be byte-for-byte the same crawl as the async
// `buildAnalyzeInput`; this differential test pins them together so the two
// hand-kept bodies cannot drift.

const FILES: Record<string, string> = {
  '/App.svelte': [
    '<script>',
    "  import Direct from './Direct.svelte';",
    "  import { Barrel } from './ui/index.js';",
    "  import * as ns from './ns/index.js';",
    '</script>',
    '<Direct /><Barrel /><ns.Member />',
  ].join('\n'),
  '/Direct.svelte': '<script>let { a } = $props();</script>{a}',
  '/ui/index.js': "export { default as Barrel } from './Barrel.svelte';",
  '/ui/Barrel.svelte': '<script>let { b } = $props();</script>{b}',
  '/ns/index.js': "export { default as Member } from './Member.svelte';",
  '/ns/Member.svelte': '<script>let { c } = $props();</script>{c}',
};

const resolveSync: ResolveSync = (source, importer) =>
  source.startsWith('.') ? new URL(source, `file://${importer}`).pathname : null;
const readFileSync: ReadFileSync = (id) => {
  const code = FILES[id];
  if (code === undefined) throw new Error(`no such file: ${id}`);
  return code;
};
const resolve: Resolve = resolveSync;
const readFile: ReadFile = readFileSync;

describe('buildAnalyzeInputSync', () => {
  it('produces the identical AnalyzeInput as the async crawl (direct/barrel/namespace)', async () => {
    const asyncInput = await buildAnalyzeInput('/App.svelte', resolve, readFile);
    const syncInput = buildAnalyzeInputSync('/App.svelte', resolveSync, readFileSync);
    expect(syncInput).toEqual(asyncInput);
    // sanity: every reachable `.svelte` was crawled (the `.js` barrels are
    // consumed during resolution and do not appear in `files`)
    expect(syncInput.files.map((f) => f.id).sort()).toEqual([
      '/App.svelte',
      '/Direct.svelte',
      '/ns/Member.svelte',
      '/ui/Barrel.svelte',
    ]);
  });
});
