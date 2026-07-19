// Runs the svelte-shaker engine entirely in the browser over an in-memory file
// map, then measures the result by compiling the *reachable* components with
// svelte/compiler and summing bytes — so the bundle-size win is real, not faked.
import {
  svelteShaker,
  svelteShakerWithMono,
  analyze,
  type ComponentId,
} from 'svelte-shaker';
import { compile, parse } from 'svelte/compiler';

export type Files = Record<string, string>; // 'App.svelte' -> source
export const ENTRY = 'App.svelte';

export interface Sizes {
  js: number;
  css: number;
  modules: number;
}

export interface Eliminated {
  propsFolded: number; // dropped from $props() + folded to a constant
  propsNarrowed: number; // value-set narrowed (kept, dead arms removed)
  deadBranches: number; // {#if} chains removed
  cssRules: number; // <style> rules removed
  componentsDropped: number; // child modules no longer reachable
  bailed: string[]; // components left untouched (with reason)
}

export interface ShakeOutput {
  shaken: Files; // shaken source per original file
  variants: { id: string; code: string }[]; // monomorphization specialized modules
  dropped: string[]; // files reachable before but not after — gone from the bundle
  before: Sizes;
  after: Sizes;
  eliminated: Eliminated;
  error?: string;
}

// ---- in-memory module resolution -------------------------------------

function dirOf(id: string): string {
  const i = id.lastIndexOf('/');
  return i === -1 ? '' : id.slice(0, i);
}

/** Resolve `./Child.svelte` (and synthetic variant ids) within the file map. */
function makeResolve(keys: () => Set<string>) {
  return (source: string, importer: ComponentId): ComponentId | null => {
    if (keys().has(source)) return source; // synthetic (e.g. an monomorphization variant id)
    if (!source.startsWith('.')) return null;
    const parts = `${dirOf(importer)}/${source}`.split('/');
    const out: string[] = [];
    for (const p of parts) {
      if (p === '' || p === '.') continue;
      if (p === '..') out.pop();
      else out.push(p);
    }
    const id = out.join('/');
    return keys().has(id) ? id : null;
  };
}

// ---- public API ------------------------------------------------------

export async function shake(files: Files, l2: boolean): Promise<ShakeOutput> {
  const resolve = makeResolve(() => new Set(Object.keys(files)));
  const readFile = (id: ComponentId) => {
    const code = files[id];
    if (code === undefined) throw new Error(`not found: ${id}`);
    return code;
  };

  try {
    const { plans } = await analyze(ENTRY, resolve, readFile);

    let shaken: Files;
    const variants: { id: string; code: string }[] = [];
    if (l2) {
      const out = await svelteShakerWithMono(ENTRY, resolve, readFile, {
        enabled: true,
        maxVariants: 16,
        minSavings: 0,
      });
      shaken = out.files;
      for (const v of out.mono.variants.values())
        variants.push({ id: v.id, code: v.code });
    } else {
      shaken = await svelteShaker(ENTRY, resolve, readFile);
    }

    const before = measure(files, {});
    const afterMap: Files = { ...shaken };
    for (const v of variants) afterMap[v.id] = v.code;
    const after = measure(afterMap, {});

    const afterLive = reachable(afterMap);
    const dropped = [...reachable(files)].filter((id) => !afterLive.has(id));

    const eliminated = summarize(files, shaken, plans, before, after);
    return { shaken, variants, dropped, before, after, eliminated };
  } catch (err) {
    const empty: Sizes = { js: 0, css: 0, modules: 0 };
    return {
      shaken: files,
      variants: [],
      dropped: [],
      before: empty,
      after: empty,
      eliminated: blankEliminated(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---- measurement: compile the REACHABLE set and sum bytes -------------

function measure(files: Files, _opts: Record<string, never>): Sizes {
  const live = reachable(files);
  let js = 0;
  let css = 0;
  for (const id of live) {
    const code = files[id];
    if (code === undefined) continue;
    try {
      const r = compile(code, { generate: 'client', dev: false, filename: id });
      js += r.js.code.length;
      css += r.css?.code.length ?? 0;
    } catch {
      js += code.length; // shouldn't happen for valid Svelte; degrade gracefully
    }
  }
  return { js, css, modules: live.size };
}

/** The set of components actually RENDERED from the entry (dead arms already
 *  removed from shaken source, so their `<Child>` usages don't count). */
function reachable(files: Files): Set<string> {
  const seen = new Set<string>([ENTRY]);
  const queue: string[] = [ENTRY];
  const resolve = makeResolve(() => new Set(Object.keys(files)));
  while (queue.length) {
    const id = queue.shift()!;
    const code = files[id];
    if (code === undefined) continue;
    for (const childId of renderedChildren(code, id, resolve)) {
      if (!seen.has(childId)) {
        seen.add(childId);
        queue.push(childId);
      }
    }
  }
  return seen;
}

/** Child component ids this source actually renders (via `<Name .../>`). */
function renderedChildren(
  code: string,
  id: string,
  resolve: (s: string, i: string) => string | null,
): string[] {
  let ast: any;
  try {
    ast = parse(code, { modern: true, filename: id });
  } catch {
    return [];
  }
  const localToSource = new Map<string, string>();
  for (const stmt of ast.instance?.content?.body ?? []) {
    if (stmt.type !== 'ImportDeclaration') continue;
    for (const spec of stmt.specifiers ?? [])
      if (spec.type === 'ImportDefaultSpecifier')
        localToSource.set(spec.local.name, stmt.source.value);
  }
  const out: string[] = [];
  walk(ast.fragment, (node: any) => {
    if (node?.type === 'Component' && node.name) {
      const src = localToSource.get(node.name);
      if (src) {
        const resolved = resolve(src, id);
        if (resolved) out.push(resolved);
      }
    }
  });
  return out;
}

function walk(node: any, visit: (n: any) => void): void {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end') continue;
    const v = node[key];
    if (Array.isArray(v)) for (const c of v) walk(c, visit);
    else if (v && typeof v === 'object' && typeof v.type === 'string')
      walk(v, visit);
  }
}

// ---- "what was eliminated" summary -----------------------------------

function summarize(
  before: Files,
  after: Files,
  plans: Map<string, any>,
  bSize: Sizes,
  aSize: Sizes,
): Eliminated {
  const e = blankEliminated();
  for (const plan of plans.values()) {
    if (plan.bail) {
      e.bailed.push(`${short(plan.id)} (${plan.reasons[0] ?? 'unsafe'})`);
      continue;
    }
    e.propsFolded += plan.constFold?.size ?? 0;
    e.propsNarrowed += plan.narrow?.size ?? 0;
  }
  for (const id of Object.keys(before)) {
    const a = after[id];
    if (a === undefined) continue;
    e.deadBranches += countNodes(before[id]!, 'IfBlock') - countNodes(a, 'IfBlock');
    e.cssRules += cssRuleCount(before[id]!) - cssRuleCount(a);
  }
  e.deadBranches = Math.max(0, e.deadBranches);
  e.cssRules = Math.max(0, e.cssRules);
  e.componentsDropped = Math.max(0, bSize.modules - aSize.modules);
  return e;
}

function blankEliminated(): Eliminated {
  return {
    propsFolded: 0,
    propsNarrowed: 0,
    deadBranches: 0,
    cssRules: 0,
    componentsDropped: 0,
    bailed: [],
  };
}

function countNodes(code: string, type: string): number {
  let n = 0;
  try {
    const ast: any = parse(code, { modern: true });
    walk(ast.fragment, (node: any) => {
      // count only chain heads, not `{:else if}` continuations
      if (node?.type === type && !node.elseif) n += 1;
    });
  } catch {
    /* ignore */
  }
  return n;
}

function cssRuleCount(code: string): number {
  try {
    const ast: any = parse(code, { modern: true });
    return (ast.css?.children ?? []).filter((c: any) => c.type === 'Rule')
      .length;
  } catch {
    return 0;
  }
}

function short(id: string): string {
  return id.split('/').pop() ?? id;
}
