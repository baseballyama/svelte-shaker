import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plugin } from 'rollup';
import {
  svelteShaker,
  svelteShakerWithMono,
  DEFAULT_MONO_OPTIONS,
  type MonomorphizeOptions,
} from 'svelte-shaker';
import { fsResolve, collectSvelteFiles } from 'svelte-shaker/node';

export interface Options {
  /**
   * Directories to scan for `.svelte` components.  Their union must contain the
   * whole app for prop elimination to be sound (docs/ARCHITECTURE.md §4.2).
   */
  include: string[];
  /** Base directory for resolving `include` (defaults to `process.cwd()`). */
  cwd?: string;
  /**
   * Optimization level (docs §3).  L0/L1/L1.5 are always on; only `level: 2`
   * additionally enables L2 per-call-site monomorphization, which is OPT-IN.
   * Default `1` — behavior with the level unset is unchanged.
   */
  level?: 0 | 1 | 2;
  /**
   * L2 monomorphization tuning (docs §13.2).  Only consulted when `level: 2`.
   * `true` enables it with defaults; an object overrides `maxVariants`.  Defaults
   * to OFF.
   */
  monomorphize?: boolean | Partial<Omit<MonomorphizeOptions, 'enabled'>>;
}

/** Query flag a specialized-variant `.svelte` request carries. */
const VARIANT_QUERY = 'shaker_variant';

/** Resolve {@link MonomorphizeOptions} from the public surface (OFF unless opted in). */
function resolveMono(options: Options): MonomorphizeOptions {
  if (options.level !== 2 || !options.monomorphize) return DEFAULT_MONO_OPTIONS;
  const overrides = typeof options.monomorphize === 'object' ? options.monomorphize : {};
  return { ...DEFAULT_MONO_OPTIONS, enabled: true, ...overrides };
}

/**
 * Source-level Svelte tree-shaking as a Rollup plugin.  The Vite plugin
 * (`svelte-shaker/vite`) is preferred for apps; this exists for plain Rollup
 * pipelines.  Must run before the Svelte compiler plugin.
 *
 * L2 wiring (opt-in, `level: 2`): a specialized variant is exposed as a request
 * for the ORIGINAL child file with a `?shaker_variant=<id>` query, so the
 * variant's own relative imports resolve as in the unspecialized child; our
 * `load` serves the residual.  Identical residuals dedup to one module.
 */
export default function rollupPluginSvelteShaker(options: Options): Plugin {
  const mono = resolveMono(options);
  let shaken: Record<string, string> = {};
  let variantSources = new Map<string, string>();
  const base = options.cwd ?? process.cwd();

  const variantSpecifier = (variantId: string): string => {
    const sep = variantId.lastIndexOf('::v');
    const childPath = variantId.slice(0, sep);
    const n = variantId.slice(sep + 3);
    return `${childPath}?${VARIANT_QUERY}=${n}`;
  };

  return {
    name: 'svelte-shaker',
    async buildStart() {
      const entries = options.include.flatMap((p) => collectSvelteFiles(path.resolve(base, p)));
      const read = (id: string) => fs.readFileSync(id, 'utf-8');
      if (entries.length === 0) {
        shaken = {};
        variantSources = new Map();
        return;
      }
      if (!mono.enabled) {
        shaken = await svelteShaker(entries, fsResolve, read);
        variantSources = new Map();
        return;
      }
      const result = await svelteShakerWithMono(entries, fsResolve, read, mono, variantSpecifier);
      shaken = result.files;
      variantSources = new Map();
      for (const v of result.mono.variants.values())
        variantSources.set(variantSpecifier(v.id), v.code);
    },

    resolveId(source, importer) {
      if (!source.includes(`${VARIANT_QUERY}=`)) return null;
      const [spec, query] = source.split('?');
      if (!spec || !spec.endsWith('.svelte')) return null;
      const dir = importer ? path.dirname(importer.split('?')[0]!) : base;
      const abs = spec.startsWith('.') ? path.resolve(dir, spec) : spec;
      return `${abs}?${query}`;
    },

    load(id) {
      if (!id.includes(`${VARIANT_QUERY}=`)) return null;
      return variantSources.get(id) ?? null;
    },

    transform(code, id) {
      if (id.includes(`${VARIANT_QUERY}=`)) return null; // variant already served
      const file = id.split('?')[0]!;
      if (!file.endsWith('.svelte')) return null;
      const out = shaken[file];
      if (out == null || out === code) return null;
      // Real shaken→original mappings are a later engine milestone
      // (docs/RUST-MIGRATION.md — `TransformResult.map`). Until then we replace
      // the source without a map, so we return the `{ mappings: '' }` sentinel that
      // Rollup's public `SourceMapInput` type carries as an explicit member: its
      // runtime (`decodedSourcemap`) special-cases that value as "no map declared"
      // and skips it instead of setting the missing-map flag, so SOURCEMAP_BROKEN
      // never fires. A bare string would leave the flag set and trigger the warning.
      return { code: out, map: { mappings: '' } };
    },
  };
}
