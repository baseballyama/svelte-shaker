import { describe, expect, it } from 'vitest';
import { buildAnalyzeInput, findNeverPassedProps, type ReadFile, type Resolve } from '../src/index';

// Resolving a barrel (`.js`/`.ts` re-export) costs a module read+parse, so the
// crawl does it ONLY for named imports actually rendered as a `<Local>` here. A
// value-only named import (a helper/type) must NOT pull in its module — while a
// rendered barrel import must still be followed and attributed (soundness).
const resolve: Resolve = (source, importer) =>
  source.startsWith('.') ? new URL(source, `file://${importer}`).pathname : null;

describe('lazy barrel resolution', () => {
  it('does not read the module behind a value-only named import', async () => {
    const files: Record<string, string> = {
      '/App.svelte': [
        '<script>',
        "  import { Cmp } from './ui.js';", // rendered below -> barrel followed
        "  import { helper } from './util.js';", // value only -> must NOT be read
        '  helper();',
        '</script>',
        '<Cmp a={1} />',
      ].join('\n'),
      '/ui.js': "export { default as Cmp } from './Cmp.svelte';",
      '/Cmp.svelte': '<script>let { a, b } = $props();</script>\n{a}{b}',
      '/util.js': 'export const helper = () => {};',
    };
    const reads: string[] = [];
    const readFile: ReadFile = (id) => {
      reads.push(id);
      const code = files[id];
      if (code === undefined) throw new Error(`no such file: ${id}`);
      return code;
    };

    const input = await buildAnalyzeInput('/App.svelte', resolve, readFile);

    // The rendered barrel (`ui.js`) is read to attribute `<Cmp>`; the value-only
    // barrel (`util.js`) is never touched.
    expect(reads).toContain('/ui.js');
    expect(reads).not.toContain('/util.js');

    // Attribution is preserved: `<Cmp a=…>` is a call site, so `a` is passed and
    // `b` (never passed) is still reported.
    const unpassed = findNeverPassedProps(input);
    const cmp = unpassed.get('/Cmp.svelte')?.map((p) => p.name);
    expect(cmp).toEqual(['b']);
  });
});
