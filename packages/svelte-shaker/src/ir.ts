// ----------------------------------------------------------------------
// IR / data contract between the analysis and the transform.
// See docs/ARCHITECTURE.md §5.1.  This is the M0 (walking-skeleton) subset:
// only the pieces basic1 exercises, but shaped so later levels slot in.
// ----------------------------------------------------------------------

/** Resolved absolute path of a `.svelte` file. */
export type ComponentId = string;

/** A statically-known literal value a prop can take. */
export type Literal = string | number | boolean | null | undefined;

// ----------------------------------------------------------------------
// Batched engine boundary (docs/RUST-MIGRATION.md §2.1 / ARCHITECTURE §5.1).
// The Shell resolves the whole module graph up front and hands the engine ONE
// `AnalyzeInput`; the engine returns plans/output with no per-edge callback.
// Everything here is plain data (JSON-serializable) so the engine can later be a
// Rust process behind napi — only source strings + this resolved graph cross.
// ----------------------------------------------------------------------

/**
 * How an imported local name binds to a child `.svelte` component.  All three
 * kinds are attributable — the `local` they carry is the exact tag name a call
 * site renders (`Child` for the first two, the dotted `ns.Child` for the third),
 * so {@link AnalyzeInput} drives the child's value set off every one of them.
 */
export type EdgeKind =
  | 'default-svelte' // `import Child from './Child.svelte'` — a direct default import
  | 'barrel' // a simple local (named specifier, or default of a `.js`/`.ts` barrel) resolved to a `.svelte`
  | 'namespace'; // a `<ns.Child/>` member tag where `ns` is `import * as ns` of a barrel

/** One reachable `.svelte` source the engine will model. */
export interface InputFile {
  id: ComponentId;
  code: string;
}

/**
 * One resolved import edge: in `from`, the tag name `local` renders the child
 * `.svelte` `to`.  `local` is the literal tag a call site uses — a bare name for
 * `default-svelte`/`barrel` (`<Child/>`) or a dotted member for `namespace`
 * (`<ns.Child/>`) — so the engine attributes `<local .../>` sites by name lookup.
 */
export interface ResolvedEdge {
  from: ComponentId;
  local: string;
  to: ComponentId;
  kind: EdgeKind;
}

/**
 * The fully-resolved, batched input to the engine (docs §2.1).  `files` is every
 * reachable `.svelte` (barrel `.js`/`.ts` are consumed during resolution and do
 * not appear here); `edges` are already resolved to absolute ids; `entries` is
 * the call-site-completeness set (the Shell's FS scan) and the monomorphization net-win roots.
 */
export interface AnalyzeInput {
  files: InputFile[];
  edges: ResolvedEdge[];
  entries: ComponentId[];
  /**
   * Components with at least one consumer OUTSIDE the analyzed `.svelte` graph —
   * a call site in a `.ts`/`.js` module (`mount(Comp, …)`, a lazy `import()`), or
   * a user-declared `preserve` (docs/ARCHITECTURE.md §4.2).  The Shell computes
   * this set (its FS scan cannot parse `.ts` call sites); the engine unions it
   * into the same whole-component escape bail auto-detected escapes use, so these
   * components are never folded and never reported as never-passed — while their
   * OWN call sites still count toward their children.  Omitted/`[]` means every
   * consumer is inside the crawled `.svelte` graph, keeping the output
   * byte-for-byte unchanged.
   */
  escaped?: ComponentId[];
}

/**
 * The delta the dev engine returns after applying file changes (docs §2.1, the
 * `vite dev` incremental path).  `changed` maps each component whose SLIMMED
 * OUTPUT changed to its new source — a SUPERSET of the edited files, because a
 * call-site edit can change a child's residual without the child being touched
 * (the HMR module-graph divergence the Shell must widen for).  `removed` lists
 * components no longer in the program (deleted or now unreachable).
 */
export interface EditResult {
  changed: Record<ComponentId, string>;
  removed: ComponentId[];
}

/**
 * The join, over every call site in the program, of the value passed to a
 * single prop.  See the lattice in docs/ARCHITECTURE.md §2.2.
 *
 * M0 only ever produces `const` (single literal across all sites) and `top`
 * (something we cannot reason about — never fold).  `multi` / `dynamic` are
 * declared now so value-set narrowing can be added without reshaping callers.
 */
export type PropAbstraction =
  | { kind: 'bottom' } // no call site has been seen yet
  | { kind: 'const'; value: Literal } // collapses to a single literal
  | { kind: 'multi'; values: Literal[] } // value-set narrowing: reachable value set
  | { kind: 'dynamic' } // used, value not statically known
  | { kind: 'top'; reason: string }; // cannot be touched (bail this prop)

/**
 * The set of literal values one declared prop is seen to take across the whole
 * program (default included for sites that omit it), plus the two ways it can
 * escape the lattice.  This is the value-set foundation later levels narrow on
 * (docs §2.2 `multi`, §3 value-set narrowing): `constFold` is just the `size === 1 && !dynamic
 * && !top` projection of it.  Kept on the plan as groundwork — no level yet
 * consumes the multi-element / `dynamic` cases.
 */
export interface PropValueSet {
  /** Distinct literals observed (dedup'd; `undefined`/`null` are distinct). */
  values: Literal[];
  /** A non-literal value was passed somewhere (used, value not statically known). */
  dynamic: boolean;
  /**
   * ⊤: a call-site spread may set this prop (docs §4.1 partial bail), so the
   * value set is really "all values" and the prop must not be folded.
   */
  top: boolean;
}

/** What the analysis decides to do to one component. */
export interface ComponentPlan {
  id: ComponentId;
  /** Whole-component bail (accessors / customElement / escape). */
  bail: boolean;
  reasons: string[];
  /**
   * unused-prop fold / constant fold: props that collapse to a single constant.  Under the "攻め"
   * default (docs §12-2) these are folded in the body, dropped from the
   * `$props()` signature, and their attributes are removed at every call site.
   */
  constFold: Map<string, Literal>;
  /**
   * value-set narrowing (docs §3): props whose reachable value set is a
   * known set of >= 2 distinct literals (no `dynamic`/`top` contribution).  We
   * delete branches the prop can provably never reach (e.g. a `variant ===
   * 'danger'` arm when `variant ∈ {'primary','secondary'}`), but — unlike
   * `constFold` — the prop is still genuinely used/dynamic, so it is NOT
   * substituted and NOT dropped from the `$props()` signature.  Singletons stay
   * in `constFold`; these two maps are disjoint.
   */
  narrow: Map<string, Literal[]>;
  /**
   * Per-declared-prop value-set foundation (see {@link PropValueSet}).  Present
   * for every declared prop the analysis reasoned about; `constFold` is its
   * singleton projection and `narrow` is its multi-element projection.
   */
  valueSets: Map<string, PropValueSet>;
}

/**
 * Whether a proven value may be SUBSTITUTED into the residual as a constant.
 *
 * Every member of {@link Literal} has a faithful source form except `-0`: the
 * Svelte compiler constant-folds the expression it is spliced into and loses the
 * sign of zero there (`{1 / n}` renders `-Infinity` with `n = -0` at runtime,
 * but the folded `{1 / (-0)}` compiles to a literal `Infinity`).  Emitting it
 * would therefore change what renders even though the value we proved is right,
 * so a `-0`-valued prop is simply left alone — one missed fold, no risk.
 *
 * Narrowing is unaffected: a narrowed prop stays dynamic and is never
 * substituted, and the comparisons it feeds use real JS semantics.
 */
export function isFoldableValue(value: Literal): boolean {
  return !Object.is(value, -0);
}

export function emptyPlan(id: ComponentId): ComponentPlan {
  return {
    id,
    bail: false,
    reasons: [],
    constFold: new Map(),
    narrow: new Map(),
    valueSets: new Map(),
  };
}
