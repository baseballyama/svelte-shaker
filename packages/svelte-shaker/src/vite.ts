import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plugin } from 'vite';
import { svelteShaker, svelteShakerWithMono, fsResolve } from './index';
import { collectSvelteFiles } from './scan';
import { DEFAULT_MONO_OPTIONS, type MonomorphizeOptions } from './mono';
import type { ComponentId } from './ir';

export interface ShakerOptions {
  /**
   * Directories (relative to the Vite root) to scan for `.svelte` components.
   * Defaults to the Vite root itself.  Every `.svelte` file found is treated as
   * a call-site source, so the union of these dirs must contain the whole app
   * for prop elimination to be sound (docs/ARCHITECTURE.md §4.2).
   */
  include?: string[];
  /**
   * Optimization level (docs §3).  L0/L1/L1.5 are always on (`level >= 1`); only
   * `level: 2` additionally enables L2 per-call-site monomorphization, which is
   * OPT-IN.  Default `1` — behavior with the level unset is unchanged.
   */
  level?: 0 | 1 | 2;
  /**
   * L2 monomorphization tuning (docs §13.2).  Only consulted when `level: 2`.
   * `true` enables it with defaults; an object overrides `maxVariants`.  Defaults
   * to OFF.
   */
  monomorphize?: boolean | Partial<Omit<MonomorphizeOptions, 'enabled'>>;
}

/** Query flag a specialized-variant `.svelte` request carries (see below). */
const VARIANT_QUERY = 'shaker_variant';

/**
 * Resolve the {@link MonomorphizeOptions} from the public option surface.  L2 is
 * active only when `level: 2` AND `monomorphize` is truthy; anything else leaves
 * it disabled (the default), so existing configs are unaffected.
 */
function resolveMono(options: ShakerOptions): MonomorphizeOptions {
  if (options.level !== 2 || !options.monomorphize) return DEFAULT_MONO_OPTIONS;
  const overrides =
    typeof options.monomorphize === 'object' ? options.monomorphize : {};
  return { ...DEFAULT_MONO_OPTIONS, enabled: true, ...overrides };
}

/**
 * Source-level Svelte tree-shaking as a Vite plugin (docs/ARCHITECTURE.md §6).
 *
 * Build-only by design: `apply: 'build'` makes dev a pass-through, because the
 * whole-program analysis is incompatible with HMR's locality (§6.2).
 * `enforce: 'pre'` runs us before `@sveltejs/vite-plugin-svelte`, so we hand it
 * already-slimmed `.svelte` source and stay decoupled from Svelte's codegen.
 *
 * L2 wiring (opt-in, `level: 2`): a specialized variant is exposed as a request
 * for the ORIGINAL child file with a `?shaker_variant=<id>` query.  Keeping the
 * real `.svelte` path means the variant's own relative imports (`./Icon.svelte`)
 * resolve exactly as they would in the unspecialized child, and vite-plugin-svelte
 * still compiles it as a normal component; our `transform` swaps in the variant
 * residual for that id.  Two call sites with byte-identical residuals share one
 * variant id (dedup), so they share one compiled module.
 */
export function shaker(options: ShakerOptions = {}): Plugin {
  const mono = resolveMono(options);
  let shaken: Record<ComponentId, string> = {};
  /** Variant request id (`<childPath>?shaker_variant=<n>`) -> residual source. */
  let variantSources = new Map<string, string>();
  let root = process.cwd();

  /** The module specifier the rewritten owner imports a given variant from. */
  const variantSpecifier = (variantId: string): string => {
    // `variantId` is `<childPath>::v<n>`; turn it into a query request on the
    // real child path so relative imports inside the residual still resolve.
    const sep = variantId.lastIndexOf('::v');
    const childPath = variantId.slice(0, sep);
    const n = variantId.slice(sep + 3);
    return `${childPath}?${VARIANT_QUERY}=${n}`;
  };

  return {
    name: 'vite-plugin-svelte-shaker',
    enforce: 'pre',
    apply: 'build',

    configResolved(config) {
      root = config.root;
    },

    // Phase 1 (docs §6.1): crawl the whole component graph and compute plans
    // before any file is compiled.
    async buildStart() {
      const dirs = (options.include ?? ['.']).map((p) => path.resolve(root, p));
      const entries = dirs.flatMap(collectSvelteFiles);
      if (entries.length === 0) {
        shaken = {};
        variantSources = new Map();
        return;
      }
      const read = (id: ComponentId) => fs.readFileSync(id, 'utf-8');

      if (!mono.enabled) {
        // Default path: byte-for-byte the L0/L1/L1.5 output (no L2 at all).
        shaken = await svelteShaker(entries, fsResolve, read);
        variantSources = new Map();
        return;
      }

      const result = await svelteShakerWithMono(
        entries,
        fsResolve,
        read,
        mono,
        variantSpecifier,
      );
      shaken = result.files;
      variantSources = new Map();
      for (const v of result.mono.variants.values())
        variantSources.set(variantSpecifier(v.id), v.code);
    },

    // A `?shaker_variant` request resolves to the real child path (so relative
    // imports inside it work); we keep the query so `load`/`transform` can tell
    // the variant apart from the base module.  Returning the id verbatim marks it
    // resolved by us.
    resolveId(source, importer) {
      if (!source.includes(`${VARIANT_QUERY}=`)) return null;
      const [spec, query] = source.split('?');
      if (!spec || !spec.endsWith('.svelte')) return null;
      // Resolve the child path relative to the importer (the rewritten owner).
      const base = importer ? path.dirname(importer.split('?')[0]!) : root;
      const abs = spec.startsWith('.') ? path.resolve(base, spec) : spec;
      return `${abs}?${query}`;
    },

    load(id) {
      // Vite's default loader reads the file on disk ignoring the query, which
      // would give the UNspecialized child source.  Serve the variant residual
      // ourselves so the `?shaker_variant` request gets the specialized code.
      if (!id.includes(`${VARIANT_QUERY}=`)) return null;
      return variantSources.get(id) ?? null;
    },

    // Phase 2: hand the slimmed source to the Svelte plugin.
    transform(code, id) {
      // A specialized-variant request: its source is already the residual we put
      // there in `load`, so let it flow through to vite-plugin-svelte untouched.
      if (id.includes(`${VARIANT_QUERY}=`)) return null;
      // Only the *main* `.svelte` module request must be slimmed. vite-plugin-svelte
      // splits a component into sub-resource requests (`Foo.svelte?svelte&type=style&lang.css`,
      // `…&type=script`) whose path still ends in `.svelte`; returning the full
      // slimmed source for those would clobber the extracted CSS/JS with raw
      // component source. Skip anything carrying the Svelte sub-resource marker.
      if (id.includes('svelte&type=')) return null;
      const file = id.split('?')[0]!;
      if (!file.endsWith('.svelte')) return null;
      const out = shaken[file];
      if (out == null || out === code) return null;
      return out;
    },
  };
}
