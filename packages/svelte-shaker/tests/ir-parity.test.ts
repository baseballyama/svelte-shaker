import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSvelte } from '../src/parse';
import { loadNativeAddon } from './native-addon';

// IR parity pin: the engine's internal template IR must find EXACTLY the same
// `<Component>` call sites (tag name + span) as the Value walk that backs `child_calls`
// — the load-bearing template read of `build_model` (which consumes the IR). This
// exercises the Value→IR converter + the IR walk end-to-end on every golden fixture
// (plus example/e2e) as a focused check; the full-shake corpus tests cover the IR
// through the whole shake. A napi shim (`irComponentTags`) runs the IR walk so the
// committed wasm is untouched.
interface Addon {
  irComponentTags: (astJson: string) => string;
}
const addon = loadNativeAddon<Addon>();

type Tag = { name: string; start: number; end: number };

/** The engine's current Value walk: every `type: "Component"` node, in the whole AST. */
function valueComponents(ast: unknown): Tag[] {
  const out: Tag[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    const node = n as Record<string, unknown>;
    if (node['type'] === 'Component') {
      out.push({
        name: node['name'] as string,
        start: node['start'] as number,
        end: node['end'] as number,
      });
    }
    for (const k of Object.keys(node)) if (k !== 'type') walk(node[k]);
  };
  walk((ast as { fragment?: unknown }).fragment);
  return out;
}

const byStart = (t: Tag[]) => [...t].sort((a, b) => a.start - b.start);

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

describe.skipIf(!addon)('M4 IR walk finds the same Components as the Value walk', () => {
  it(`agrees on every corpus .svelte (${corpus.length} files)`, () => {
    for (const file of corpus) {
      const code = readFileSync(file, 'utf-8');
      const ast = parseSvelte(code, file);
      const viaValue = byStart(valueComponents(ast));
      const viaIr = byStart(JSON.parse(addon!.irComponentTags(JSON.stringify(ast))) as Tag[]);
      expect(viaIr, file).toEqual(viaValue);
    }
  });
});
