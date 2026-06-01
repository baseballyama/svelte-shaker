// ----------------------------------------------------------------------
// IR / data contract between the analysis and the transform.
// See docs/ARCHITECTURE.md §5.1.  This is the M0 (walking-skeleton) subset:
// only the pieces basic1 exercises, but shaped so later levels slot in.
// ----------------------------------------------------------------------

/** Resolved absolute path of a `.svelte` file. */
export type ComponentId = string;

/** A statically-known literal value a prop can take. */
export type Literal = string | number | boolean | null | undefined;

/**
 * The join, over every call site in the program, of the value passed to a
 * single prop.  See the lattice in docs/ARCHITECTURE.md §2.2.
 *
 * M0 only ever produces `const` (single literal across all sites) and `top`
 * (something we cannot reason about — never fold).  `multi` / `dynamic` are
 * declared now so L1.5 narrowing can be added without reshaping callers.
 */
export type PropAbstraction =
  | { kind: 'bottom' } // no call site has been seen yet
  | { kind: 'const'; value: Literal } // collapses to a single literal
  | { kind: 'multi'; values: Literal[] } // L1.5: reachable value set
  | { kind: 'dynamic' } // used, value not statically known
  | { kind: 'top'; reason: string }; // cannot be touched (bail this prop)

/**
 * The set of literal values one declared prop is seen to take across the whole
 * program (default included for sites that omit it), plus the two ways it can
 * escape the lattice.  This is the value-set foundation later levels narrow on
 * (docs §2.2 `multi`, §3 L1.5): `constFold` is just the `size === 1 && !dynamic
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
   * L0/L1: props that collapse to a single constant.  Under the "攻め"
   * default (docs §12-2) these are folded in the body, dropped from the
   * `$props()` signature, and their attributes are removed at every call site.
   */
  constFold: Map<string, Literal>;
  /**
   * L1.5 value-set narrowing (docs §3): props whose reachable value set is a
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
