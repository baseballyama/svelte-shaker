import { afterAll, describe, expect, it } from 'vitest';
import { svelteShaker } from '../src/index';
import { assertCompiles, cleanTmp, renderGraphHtml } from './diff';

afterAll(() => cleanTmp());

// ----------------------------------------------------------------------
// Reverse analysis (docs §PR4): an input a child component can NEVER read is
// removed at every call site — a call-site ATTRIBUTE for an undeclared prop, a
// `{#snippet}` block for an undeclared snippet, and the body content when the
// child never reads `children`.  The child's "reachable input set" is derived
// syntactically from its `$props()` destructure; when it cannot be pinned down
// (rest, non-ObjectPattern binding, a bail) NOTHING is removed.
//
// Every probe runs the real engine over an in-memory App -> … graph and asserts
// BOTH that the expected removal happened AND that the whole program still
// server-renders identical HTML (the soundness oracle).
// ----------------------------------------------------------------------

/** Minimal in-memory module graph for the engine (POSIX-style absolute ids). */
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

/** Render the whole `/App.svelte` graph (flat `/X.svelte` ids) to HTML. */
async function graphHtml(files: Record<string, string>): Promise<string> {
  const deps: Record<string, string> = {};
  for (const [id, src] of Object.entries(files)) {
    if (id === '/App.svelte') continue;
    deps[`.${id}`] = src; // `/Child.svelte` -> `./Child.svelte`
  }
  return renderGraphHtml({ specifier: './App.svelte', source: files['/App.svelte']! }, deps, {});
}

/**
 * Shake `files` from `/App.svelte`, assert the whole graph renders identical
 * HTML before/after (the soundness oracle) and every shaken file compiles, and
 * return the shaken sources merged over the originals.
 */
async function shakeSound(files: Record<string, string>): Promise<Record<string, string>> {
  const { resolve, readFile } = memGraph(files);
  const out = await svelteShaker('/App.svelte', resolve, readFile);
  const merged = { ...files, ...out };
  for (const [id, src] of Object.entries(out))
    assertCompiles(src, id.slice(id.lastIndexOf('/') + 1));
  const before = await graphHtml(files);
  const after = await graphHtml(merged);
  expect(after).toBe(before);
  return merged;
}

describe('reverse analysis: drop inputs a child can never read', () => {
  it('1. removes an undeclared prop whose value is a bare identifier', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n  const heavy = 'H';\n</script>\n` +
        `<Child icon={heavy} label="hi" />\n`,
      '/Child.svelte':
        `<script>\n  let { label } = $props();\n</script>\n` + `<span>{label}</span>\n`,
    };
    const out = await shakeSound(files);
    const app = out['/App.svelte']!;
    expect(app).not.toContain('icon='); // undeclared -> removed
    expect(app).toContain('label="hi"'); // declared -> kept
    // The only remaining mention of `heavy` is its (now dead) import/const; no
    // template reference survives, so a bundler can drop it.
    expect(app).not.toMatch(/icon=\{heavy\}/);
  });

  it('2. keeps an undeclared prop whose value is a CallExpression (side effect guard)', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n  function compute() { return 'x'; }\n</script>\n` +
        `<Child data={compute()} label="hi" />\n`,
      '/Child.svelte':
        `<script>\n  let { label } = $props();\n</script>\n` + `<span>{label}</span>\n`,
    };
    const out = await shakeSound(files);
    expect(out['/App.svelte']!).toContain('data={compute()}'); // kept: may have side effects
  });

  it('3. removes nothing when the child has a `...rest`', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n  const heavy = 'H';\n</script>\n` +
        `<Child icon={heavy} label="hi" />\n`,
      '/Child.svelte':
        `<script>\n  let { label, ...rest } = $props();\n</script>\n` +
        `<span>{label}{Object.keys(rest).join(',')}</span>\n`,
    };
    const out = await shakeSound(files);
    expect(out['/App.svelte']!).toContain('icon={heavy}'); // rest may read it -> kept
  });

  it('4. removes nothing when `$props()` binds to a non-ObjectPattern', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n  const heavy = 'H';\n</script>\n` +
        `<Child icon={heavy} label="hi" />\n`,
      '/Child.svelte':
        `<script>\n  let p = $props();\n</script>\n` + `<span>{p.label}</span>\n`,
    };
    const out = await shakeSound(files);
    expect(out['/App.svelte']!).toContain('icon={heavy}'); // p.icon reachable -> kept
  });

  it('5. removes every side-effect-free attr when the child has no `$props()`', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n  const heavy = 'H';\n</script>\n` +
        `<Child icon={heavy} title="t" />\n`,
      '/Child.svelte': `<script>\n  const x = 1;\n</script>\n` + `<span>{x}</span>\n`,
    };
    const out = await shakeSound(files);
    const app = out['/App.svelte']!;
    expect(app).not.toContain('icon=');
    expect(app).not.toContain('title=');
  });

  it('6. removes body content when the child never reads `children`', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n  import Heavy from './Heavy.svelte';\n</script>\n` +
        `<Child label="hi"><Heavy /></Child>\n`,
      '/Child.svelte':
        `<script>\n  let { label } = $props();\n</script>\n` + `<span>{label}</span>\n`,
      '/Heavy.svelte': `<b>heavy</b>\n`,
    };
    const out = await shakeSound(files);
    const app = out['/App.svelte']!;
    expect(app).not.toContain('<Heavy'); // body content removed -> import droppable
    expect(app).toContain('<Child'); // the call site itself stays
  });

  it('7. removes an undeclared named snippet block', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n</script>\n` +
        `<Child label="hi">{#snippet foo()}<b>x</b>{/snippet}</Child>\n`,
      '/Child.svelte':
        `<script>\n  let { label } = $props();\n</script>\n` + `<span>{label}</span>\n`,
    };
    const out = await shakeSound(files);
    expect(out['/App.svelte']!).not.toContain('{#snippet foo'); // undeclared snippet removed
  });

  it('8. removes nothing at a call site carrying a spread', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n  const heavy = 'H';\n  const rest = {};\n</script>\n` +
        `<Child icon={heavy} {...rest} />\n`,
      '/Child.svelte':
        `<script>\n  let { label } = $props();\n</script>\n` + `<span>{label}</span>\n`,
    };
    const out = await shakeSound(files);
    expect(out['/App.svelte']!).toContain('icon={heavy}'); // spread may set it -> kept
  });

  it('9. never removes a `bind:` directive', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n  const heavy = 'H';\n  let text = $state('');\n</script>\n` +
        `<Child bind:value={text} icon={heavy} />\n`,
      '/Child.svelte':
        `<script>\n  let { value = $bindable('') } = $props();\n</script>\n` +
        `<input bind:value />\n`,
    };
    const out = await shakeSound(files);
    const app = out['/App.svelte']!;
    expect(app).toContain('bind:value={text}'); // two-way binding -> never removed
    expect(app).not.toContain('icon='); // undeclared sibling -> removed
  });

  it('10. removes nothing when the child has bailed (escapes as a value)', async () => {
    const files = {
      '/App.svelte':
        `<script>\n  import Child from './Child.svelte';\n  const heavy = 'H';\n  const C = Child;\n</script>\n` +
        `<Child icon={heavy} label="hi" />\n<svelte:component this={C} />\n`,
      '/Child.svelte':
        `<script>\n  let { label } = $props();\n</script>\n` + `<span>{label}</span>\n`,
    };
    const out = await shakeSound(files);
    expect(out['/App.svelte']!).toContain('icon={heavy}'); // child bailed -> untouched
  });
});
