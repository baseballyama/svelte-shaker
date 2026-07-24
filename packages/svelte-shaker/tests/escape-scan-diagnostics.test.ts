import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build, type Logger } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { shaker } from '../src/vite';
import { computeEscapedComponents } from '../src/escape-scan';
import { collectSvelteFiles, fsReadFile, fsResolve } from '../src/scan';

const BASE = join(dirname(fileURLToPath(import.meta.url)), '.shaker-tmp-diag');

// A `.tsx` whose BODY is JSX: the `<script module lang="ts">` wrapper the scan uses
// parses TS but NOT JSX, so this module fails to parse — the scan must report it,
// not silently drop the call site it could hide.
const BROKEN_TSX = 'export const C = <div class="x">hi</div>;\n';
const GOOD_TS = "import W from './Widget.svelte';\nexport const w = W;\n"; // imports Widget
const WIDGET = '<script>let { p = false } = $props();</script>\n{#if p}<span>P</span>{/if}\n';

beforeAll(() => {
  rmSync(BASE, { recursive: true, force: true });
  mkdirSync(BASE, { recursive: true });
  writeFileSync(join(BASE, 'broken.tsx'), BROKEN_TSX);
  writeFileSync(join(BASE, 'good.ts'), GOOD_TS);
  writeFileSync(join(BASE, 'Widget.svelte'), WIDGET);
  writeFileSync(join(BASE, 'Other.svelte'), '<p>other</p>\n');
  writeFileSync(join(BASE, 'main.ts'), "import W from './Widget.svelte';\nexport { W };\n");
});
afterAll(() => rmSync(BASE, { recursive: true, force: true }));

describe('computeEscapedComponents — structured diagnostics', () => {
  it('reports an unparseable module in `unscannable` while still escaping a good one', async () => {
    const components = collectSvelteFiles(BASE);
    const result = await computeEscapedComponents({
      entryDirs: [BASE],
      root: BASE,
      components,
      resolve: fsResolve,
      readFile: fsReadFile,
    });
    // good.ts imports Widget → escaped; broken.tsx failed to parse → reported.
    expect(result.escaped).toContain(join(BASE, 'Widget.svelte'));
    expect(result.unscannable).toContain(join(BASE, 'broken.tsx'));
    expect(result.escaped).not.toContain(join(BASE, 'broken.tsx'));
  });

  it('reports a `preserve` entry that matches nothing (and stays quiet for a hit)', async () => {
    const components = collectSvelteFiles(BASE);
    const miss = await computeEscapedComponents({
      entryDirs: [BASE],
      root: BASE,
      preserve: ['./DoesNotExist.svelte'],
      components,
      resolve: fsResolve,
      readFile: fsReadFile,
    });
    expect(miss.unmatchedPreserve).toEqual(['./DoesNotExist.svelte']);

    const hit = await computeEscapedComponents({
      entryDirs: [BASE],
      root: BASE,
      preserve: ['./Other.svelte'],
      components,
      resolve: fsResolve,
      readFile: fsReadFile,
    });
    expect(hit.unmatchedPreserve).toEqual([]);
    expect(hit.escaped).toContain(join(BASE, 'Other.svelte'));
  });
});

// ----------------------------------------------------------------------
// Issue #146: a module whose TEXT mentions `</script>` (in a comment, string,
// regex or template literal) must still be scanned.  The `<script module>`
// wrapper the scan uses would otherwise close early on that text and drop a
// perfectly valid file into `unscannable`.
// ----------------------------------------------------------------------
const BASE_146 = join(dirname(fileURLToPath(import.meta.url)), '.shaker-tmp-146');

// The exact issue repro: `</script>` in a comment AND a regex, plus a string.
const SANITIZER_TS = `// Turns </script> into an entity so it is inert in markup.
export function sanitize(s: string): string {
  return s.replaceAll('</script>', '&lt;/script&gt;').replace(/<\\/script\\s*>/gi, '');
}
import Widget from './Widget.svelte';
export const w = Widget;
`;

// `</script>` inside a template literal.
const TEMPLATE_TS = `export const page = \`<div></script></div>\`;
import Tmpl from './Tmpl.svelte';
export const t = Tmpl;
`;

// A `.svelte.ts` rune module that mentions `</script>` in its text.
const RUNE_MODULE = `// a rune module that documents </script> handling
import Rune from './Rune.svelte';
export const child = Rune;
`;

// A genuinely broken module that also mentions `</script>`: neutralizing the
// closing tag must not mask the real syntax error — it still lands unscannable.
const BROKEN_WITH_TAG = `// mentions </script> but is not valid TS
export const = ;
`;

// A specifier that ITSELF carries `</script`: the neutralization would rewrite it,
// so the scan must degrade loudly (unscannable) rather than resolve a lie.
const CORRUPT_SPEC_TS = `import x from './a</script>b.svelte';
export const y = x;
`;

// Uppercase `</SCRIPT>` in the text — the neutralization is case-insensitive on
// purpose, so this valid module must still scan and escape its `.svelte` import.
const UPPER_TAG_TS = `// mentions </SCRIPT> in uppercase
import Up from './Upper.svelte';
export const u = Up;
`;

beforeAll(() => {
  rmSync(BASE_146, { recursive: true, force: true });
  mkdirSync(BASE_146, { recursive: true });
  writeFileSync(join(BASE_146, 'sanitizer.ts'), SANITIZER_TS);
  writeFileSync(join(BASE_146, 'template.ts'), TEMPLATE_TS);
  writeFileSync(join(BASE_146, 'rune.svelte.ts'), RUNE_MODULE);
  writeFileSync(join(BASE_146, 'broken.ts'), BROKEN_WITH_TAG);
  writeFileSync(join(BASE_146, 'corrupt-spec.ts'), CORRUPT_SPEC_TS);
  writeFileSync(join(BASE_146, 'upper.ts'), UPPER_TAG_TS);
  writeFileSync(join(BASE_146, 'Widget.svelte'), WIDGET);
  writeFileSync(join(BASE_146, 'Tmpl.svelte'), '<p>tmpl</p>\n');
  writeFileSync(join(BASE_146, 'Rune.svelte'), '<p>rune</p>\n');
  writeFileSync(join(BASE_146, 'Upper.svelte'), '<p>upper</p>\n');
});
afterAll(() => rmSync(BASE_146, { recursive: true, force: true }));

describe('computeEscapedComponents — `</script>` in module text (issue #146)', () => {
  async function scan(): Promise<Awaited<ReturnType<typeof computeEscapedComponents>>> {
    return computeEscapedComponents({
      entryDirs: [BASE_146],
      root: BASE_146,
      components: collectSvelteFiles(BASE_146),
      resolve: fsResolve,
      readFile: fsReadFile,
    });
  }

  it('scans a module with `</script>` in a comment and a regex, escaping its `.svelte` import', async () => {
    const result = await scan();
    expect(result.escaped).toContain(join(BASE_146, 'Widget.svelte'));
    expect(result.unscannable).not.toContain(join(BASE_146, 'sanitizer.ts'));
  });

  it('scans a module with `</script>` in a template literal', async () => {
    const result = await scan();
    expect(result.escaped).toContain(join(BASE_146, 'Tmpl.svelte'));
    expect(result.unscannable).not.toContain(join(BASE_146, 'template.ts'));
  });

  it('scans a `.svelte.ts` rune module with `</script>` in its text', async () => {
    const result = await scan();
    expect(result.escaped).toContain(join(BASE_146, 'Rune.svelte'));
    expect(result.unscannable).not.toContain(join(BASE_146, 'rune.svelte.ts'));
  });

  it('still reports a genuinely broken module (neutralizing the tag does not mask the error)', async () => {
    const result = await scan();
    expect(result.unscannable).toContain(join(BASE_146, 'broken.ts'));
  });

  it('reports a module whose specifier itself carries `</script` as unscannable (no silent corruption)', async () => {
    const result = await scan();
    expect(result.unscannable).toContain(join(BASE_146, 'corrupt-spec.ts'));
  });

  it('scans a module that mentions `</SCRIPT>` in uppercase (over-neutralization is harmless)', async () => {
    const result = await scan();
    expect(result.escaped).toContain(join(BASE_146, 'Upper.svelte'));
    expect(result.unscannable).not.toContain(join(BASE_146, 'upper.ts'));
  });
});

/** A Vite logger that records `warn` messages so we can assert the plugin surfaces
 * the scan diagnostics. Only `warn` matters; the rest are no-op stubs. */
function recordingLogger(warnings: string[]): Logger {
  const noop = (): void => {};
  return {
    info: noop,
    warn: (msg: string) => warnings.push(msg),
    warnOnce: (msg: string) => warnings.push(msg),
    error: noop,
    clearScreen: noop,
    hasErrorLogged: () => false,
    hasWarned: false,
  };
}

async function bundleWith(warnings: string[], pre: unknown[]): Promise<void> {
  await build({
    root: BASE,
    logLevel: 'silent',
    configFile: false,
    customLogger: recordingLogger(warnings),
    build: {
      write: false,
      minify: false,
      reportCompressedSize: false,
      target: 'esnext',
      // broken.tsx just sits on disk for the FS scan to hit; main.ts is the entry.
      rollupOptions: { input: join(BASE, 'main.ts') },
    },
    plugins: [...pre, svelte({ compilerOptions: { runes: true } })] as any,
  }).catch(() => {
    // A missing rollup input entry can still error; the warnings we assert on are
    // emitted in `buildStart` before that, so ignore the build outcome here.
  });
}

describe('vite-plugin-svelte-shaker — scan warnings', () => {
  it('warns (with the file path) about a module the scan cannot parse', async () => {
    const warnings: string[] = [];
    await bundleWith(warnings, [shaker({ entries: ['.'] })]);
    const w = warnings.find((m) => m.includes('could not parse'));
    expect(w, warnings.join('\n')).toBeDefined();
    expect(w).toContain('broken.tsx');
    expect(w).toContain('preserve');
  });

  it('warns about a `preserve` entry that matched no component', async () => {
    const warnings: string[] = [];
    await bundleWith(warnings, [shaker({ entries: ['.'], preserve: ['./Nope.svelte'] })]);
    const w = warnings.find((m) => m.includes('matched no component'));
    expect(w, warnings.join('\n')).toBeDefined();
    expect(w).toContain('./Nope.svelte');
  });
});
