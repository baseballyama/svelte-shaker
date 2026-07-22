import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { importSources, memberComponentTags, renderedComponentTagNames } from '../src/analyze';
import { parseSvelte } from '../src/parse';

// The native `parseFiles` (chatty-protocol Round 1) must return the SAME per-file
// facts the JS crawl extracts — import specifiers + rendered component tag names —
// so it can replace the JS parse+walk without changing which edges get resolved.
// This differential pins native rsvelte extraction to the JS `importSources` /
// `renderedComponentTagNames` / `memberComponentTags`, byte-for-byte, over inline
// edge cases AND the whole fixture/example/e2e corpus.
const require = createRequire(import.meta.url);
const addonPath = fileURLToPath(new URL('../engine-scan-native/index.cjs', import.meta.url));
const dylib = fileURLToPath(
  new URL(
    `../engine-scan-native/target/debug/${
      process.platform === 'darwin'
        ? 'libsvelte_shaker_engine_scan_native.dylib'
        : process.platform === 'win32'
          ? 'svelte_shaker_engine_scan_native.dll'
          : 'libsvelte_shaker_engine_scan_native.so'
    }`,
    import.meta.url,
  ),
);

interface Import {
  local: string;
  imported: string;
  source: string;
}
interface Facts {
  imports: Import[];
  renderedTags: string[];
  memberTags: string[];
  parseError: boolean;
}
interface NativeScanner {
  parseFiles: (inputJson: string) => string;
}
// Skip (do not fail) when the addon has not been built — same guard as the other
// native tests; CI builds it first.
const addon: NativeScanner | null = existsSync(dylib)
  ? (require(addonPath) as NativeScanner)
  : null;

/** The JS reference: parse with svelte/compiler, then run the three extractors. */
function jsFacts(id: string, code: string): Facts {
  const ast = parseSvelte(code, id);
  const imports = ast.instance
    ? [...importSources(ast.instance)].map((i) => ({
        local: i.local,
        imported: i.imported,
        source: i.value,
      }))
    : [];
  return {
    imports,
    renderedTags: [...renderedComponentTagNames(ast)].sort(),
    memberTags: [...memberComponentTags(ast)].sort(),
    parseError: false,
  };
}

/** The native result for a batch of files, keyed by id and normalized for compare. */
function nativeFacts(files: { id: string; code: string }[]): Record<string, Facts> {
  const out = JSON.parse(addon!.parseFiles(JSON.stringify({ files }))) as {
    files: (Facts & { id: string })[];
  };
  const map: Record<string, Facts> = {};
  for (const f of out.files) {
    map[f.id] = {
      imports: f.imports,
      renderedTags: [...f.renderedTags].sort(),
      memberTags: [...f.memberTags].sort(),
      parseError: f.parseError,
    };
  }
  return map;
}

describe.skipIf(!addon)('native parseFiles mirrors the JS extraction', () => {
  it('static default `.svelte` import; a dynamic import() is not a specifier', () => {
    const id = '/App.svelte';
    const code = [
      "<script>import Child from './Child.svelte';",
      "  const lazy = () => import('./Lazy.svelte');</script>",
      '<Child />',
    ].join('\n');
    const native = nativeFacts([{ id, code }])[id];
    expect(native).toEqual(jsFacts(id, code));
    expect(native).toEqual({
      imports: [{ local: 'Child', imported: 'default', source: './Child.svelte' }],
      renderedTags: ['Child'],
      memberTags: [],
      parseError: false,
    });
  });

  it('named + aliased + namespace imports carry the right `imported`', () => {
    const id = '/App.svelte';
    const code = [
      "<script>import { Btn } from './ui.js';",
      "  import { Card as C } from './ui.js';",
      "  import * as ns from './ui.js';</script>",
      '<Btn /><C /><ns.Panel />',
    ].join('\n');
    const native = nativeFacts([{ id, code }])[id];
    expect(native).toEqual(jsFacts(id, code));
    expect(native!.imports).toEqual([
      { local: 'Btn', imported: 'Btn', source: './ui.js' },
      { local: 'C', imported: 'Card', source: './ui.js' },
      { local: 'ns', imported: '*', source: './ui.js' },
    ]);
    expect(native!.renderedTags).toEqual(['Btn', 'C']);
    expect(native!.memberTags).toEqual(['ns.Panel']);
  });

  it('<svelte:component>/<svelte:element> are not component tags', () => {
    const id = '/App.svelte';
    const code = [
      "<script>import Leaf from './Leaf.svelte';\n  const X = Leaf;</script>",
      '<svelte:component this={X} /><svelte:element this={"div"} />',
    ].join('\n');
    const native = nativeFacts([{ id, code }])[id];
    expect(native).toEqual(jsFacts(id, code));
    expect(native!.renderedTags).toEqual([]);
    expect(native!.memberTags).toEqual([]);
  });

  it('only the INSTANCE script is read; a module-script import is ignored', () => {
    const id = '/App.svelte';
    const code = [
      "<script module>import M from './Mod.svelte';</script>",
      "<script>import I from './Inst.svelte';</script>",
      '<I /><M />',
    ].join('\n');
    const native = nativeFacts([{ id, code }])[id];
    expect(native).toEqual(jsFacts(id, code));
    // `M` is imported in the module script, so it is NOT an instance import — but it
    // IS still a rendered tag (the walk is over the whole template).
    expect(native!.imports).toEqual([{ local: 'I', imported: 'default', source: './Inst.svelte' }]);
    expect(native!.renderedTags).toEqual(['I', 'M']);
  });

  it('components nested in {#if}/{#each}/{#snippet}/elements are all collected', () => {
    const id = '/App.svelte';
    const code = [
      "<script>import A from './A.svelte';\n  import B from './B.svelte';",
      "  import C from './C.svelte';\n  import D from './D.svelte';</script>",
      '<div>{#if x}<A />{:else}<B />{/if}</div>',
      '{#each xs as _}<C />{/each}',
      '{#snippet s()}<D />{/snippet}',
    ].join('\n');
    const native = nativeFacts([{ id, code }])[id];
    expect(native).toEqual(jsFacts(id, code));
    expect(native!.renderedTags).toEqual(['A', 'B', 'C', 'D']);
  });

  it('a TS `import type` is treated exactly as the JS extractor treats it', () => {
    const id = '/App.svelte';
    const code = [
      '<script lang="ts">import type { T } from \'./types\';',
      "  import Real from './Real.svelte';\n  let x: T;</script>",
      '<Real />',
    ].join('\n');
    const native = nativeFacts([{ id, code }])[id];
    expect(native).toEqual(jsFacts(id, code));
  });

  it('a file with no instance script has no imports', () => {
    const id = '/Static.svelte';
    const code = '<h1>hello</h1>';
    const native = nativeFacts([{ id, code }])[id];
    expect(native).toEqual(jsFacts(id, code));
    expect(native).toEqual({ imports: [], renderedTags: [], memberTags: [], parseError: false });
  });

  it('batches many files in one call, each keyed by id', () => {
    const files = [
      { id: '/A.svelte', code: "<script>import X from './X.svelte';</script><X />" },
      { id: '/B.svelte', code: '<p>no script</p>' },
    ];
    const native = nativeFacts(files);
    expect(native['/A.svelte']).toEqual(jsFacts('/A.svelte', files[0]!.code));
    expect(native['/B.svelte']).toEqual(jsFacts('/B.svelte', files[1]!.code));
  });
});

// ---------------------------------------------------------------------------
// Corpus sweep: every `.svelte` in the golden fixtures + the example + the e2e app.
// ---------------------------------------------------------------------------

function svelteFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'build' || entry.name === 'dist')
        continue;
      const full = `${d}/${entry.name}`;
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.svelte')) out.push(full);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

const corpus = [
  ...svelteFilesUnder(fileURLToPath(new URL('./fixtures', import.meta.url))).filter((p) =>
    p.includes('/input/'),
  ),
  ...svelteFilesUnder(fileURLToPath(new URL('../../example/src', import.meta.url))),
  ...svelteFilesUnder(fileURLToPath(new URL('../../e2e/src', import.meta.url))),
];

describe.skipIf(!addon)('native parseFiles matches the JS extraction across the corpus', () => {
  it(`agrees on every corpus .svelte (${corpus.length} files)`, () => {
    const files = corpus.map((id) => ({ id, code: readFileSync(id, 'utf-8') }));
    const native = nativeFacts(files);
    for (const { id, code } of files) {
      // Any corpus file the JS parser accepts, rsvelte must too (parseError false)
      // and the extracted facts must match. A JS parse throw is out of scope here —
      // the corpus is all valid Svelte.
      expect(native[id], id).toEqual(jsFacts(id, code));
    }
  });
});
