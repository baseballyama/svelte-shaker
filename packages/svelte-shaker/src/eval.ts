import type { AnyNode } from './parse.js';
import type { Literal } from './ir.js';

export type EvalResult = { known: true; value: Literal } | { known: false };

const UNKNOWN: EvalResult = { known: false };

/**
 * Strip TypeScript assertion wrappers — `x as T` (`TSAsExpression`), `x!`
 * (`TSNonNullExpression`), `x satisfies T` (`TSSatisfiesExpression`) — down to
 * the runtime expression they wrap, recursing so `('a' as const)!` becomes `'a'`.
 *
 * These are compile-time-only type operators: they are erased before any code
 * runs and do not touch the operand's value, so interpreting the operand IS
 * interpreting the whole expression (docs/ARCHITECTURE.md §2.2 — the value the
 * expression abstracts to is exactly the operand's). The engine runs on the
 * `lang="ts"` source with types preserved (§6.3), so svelte/compiler hands it
 * these nodes verbatim; a parser that erases them (rsvelte today) yields the bare
 * operand instead. Unwrapping here folds both ASTs identically — the
 * parser-neutrality contract every value-interpreting entry point relies on.
 */
export function unwrapTsAssertions(node: AnyNode | null | undefined): AnyNode | null | undefined {
  let current = node;
  while (
    current?.type === 'TSAsExpression' ||
    current?.type === 'TSNonNullExpression' ||
    current?.type === 'TSSatisfiesExpression'
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * A deliberately tiny, total constant evaluator over an ESTree expression,
 * given an environment of statically-known identifiers.  It never throws and
 * never guesses: anything it cannot prove is `{ known: false }`.
 *
 * This is the M0 stand-in for the abstract-interpretation engine described in
 * docs/ARCHITECTURE.md §13 — same contract (sound over-approximation, falls to
 * unknown on non-distributive ops), just without the interprocedural lattice.
 */
export function evaluate(
  node: AnyNode | null | undefined,
  env: ReadonlyMap<string, Literal>,
): EvalResult {
  node = unwrapTsAssertions(node);
  if (!node) return UNKNOWN;
  switch (node.type) {
    case 'Literal':
      return { known: true, value: node.value as Literal };

    case 'Identifier': {
      const name = node.name ?? '';
      if (name === 'undefined') return { known: true, value: undefined };
      if (env.has(name)) return { known: true, value: env.get(name)! };
      return UNKNOWN;
    }

    case 'ConditionalExpression': {
      // `test ? a : b` — sound only when the test itself is proven: pick the
      // taken arm and evaluate it, leaving the other unevaluated (its value is
      // unreachable, so its own unknowns must not poison the result).
      const test = evaluate(node.test, env);
      if (!test.known) return UNKNOWN;
      return evaluate(test.value ? node.consequent : node.alternate, env);
    }

    case 'UnaryExpression': {
      const arg = evaluate(node.argument, env);
      if (!arg.known) return UNKNOWN;
      const v = arg.value;
      switch (node.operator) {
        case '!':
          return { known: true, value: !v };
        case '-':
          return { known: true, value: -(v as number) };
        case '+':
          return { known: true, value: +(v as number) };
        case 'typeof':
          return { known: true, value: typeof v };
        case 'void':
          return { known: true, value: undefined };
        default:
          return UNKNOWN;
      }
    }

    case 'LogicalExpression': {
      const left = evaluate(node.left, env);
      if (!left.known) return UNKNOWN;
      switch (node.operator) {
        case '&&':
          return left.value ? evaluate(node.right, env) : left;
        case '||':
          return left.value ? left : evaluate(node.right, env);
        case '??':
          return left.value === null || left.value === undefined ? evaluate(node.right, env) : left;
        default:
          return UNKNOWN;
      }
    }

    case 'BinaryExpression': {
      const left = evaluate(node.left, env);
      const right = evaluate(node.right, env);
      if (!left.known || !right.known) return UNKNOWN;
      const l = left.value;
      const r = right.value;
      switch (node.operator) {
        case '===':
          return { known: true, value: l === r };
        case '!==':
          return { known: true, value: l !== r };
        case '==':
          return { known: true, value: l == r };
        case '!=':
          return { known: true, value: l != r };
        case '<':
          return { known: true, value: (l as number) < (r as number) };
        case '>':
          return { known: true, value: (l as number) > (r as number) };
        case '<=':
          return { known: true, value: (l as number) <= (r as number) };
        case '>=':
          return { known: true, value: (l as number) >= (r as number) };
        case '+':
          return { known: true, value: (l as number) + (r as number) };
        case '-':
          return { known: true, value: (l as number) - (r as number) };
        case '*':
          return { known: true, value: (l as number) * (r as number) };
        case '/':
          return { known: true, value: (l as number) / (r as number) };
        case '%':
          return { known: true, value: (l as number) % (r as number) };
        default:
          return UNKNOWN;
      }
    }

    default:
      return UNKNOWN;
  }
}

// ----------------------------------------------------------------------
// value-set narrowing set-aware predicate (docs §3).  Where {@link evaluate} proves a value,
// this proves a *boolean branch condition* that must hold for EVERY value in a
// prop's reachable value set.  It is the sound bridge from "variant ∈
// {'primary','secondary'}" to "the `variant === 'danger'` arm is dead".
// ----------------------------------------------------------------------

/**
 * A three-valued (Kleene) truth: `true`/`false` mean "provable for every value
 * in every set var's reachable set"; `unknown` means "depends on which value is
 * actually taken" (or unsupported) — keep the branch.
 */
type Tri = true | false | 'unknown';

/**
 * Sound set-aware predicate.  `constEnv` holds props collapsed to a single
 * literal (`constFold`); `setEnv` holds props whose reachable value set is known
 * (`narrow`, >= 2 literals).  Returns `{ known:true }` ONLY when the boolean is
 * provable for the whole reachable set — a value reachable through the set keeps
 * the branch.  Anything outside the small supported fragment is `{ known:false }`.
 */
export function evaluateWithSets(
  node: AnyNode | null | undefined,
  constEnv: Map<string, Literal>,
  setEnv: Map<string, Literal[]>,
): EvalResult {
  // Constant folding alone may already settle the test (e.g. it only mentions
  // constFold props or literals); prefer that — it can even prove `true`.
  const constOnly = evaluate(node, constEnv);
  if (constOnly.known) return constOnly;

  const tri = evalTri(node, constEnv, setEnv);
  return tri === 'unknown' ? UNKNOWN : { known: true, value: tri };
}

/** Evaluate a boolean condition to a Kleene truth over the value sets. */
function evalTri(
  node: AnyNode | null | undefined,
  constEnv: Map<string, Literal>,
  setEnv: Map<string, Literal[]>,
): Tri {
  node = unwrapTsAssertions(node);
  if (!node) return 'unknown';
  switch (node.type) {
    case 'UnaryExpression':
      if (node.operator === '!') return notTri(evalTri(node.argument, constEnv, setEnv));
      return 'unknown';

    case 'LogicalExpression': {
      const left = evalTri(node.left, constEnv, setEnv);
      const right = () => evalTri(node.right, constEnv, setEnv);
      // Kleene &&/||: short-circuit on the dominating constant, else combine.
      if (node.operator === '&&') {
        if (left === false) return false; // false && _ = false
        return andTri(left, right()); // (true|unknown) && right
      }
      if (node.operator === '||') {
        if (left === true) return true; // true || _ = true
        return orTri(left, right()); // (false|unknown) || right
      }
      return 'unknown'; // ?? is value-level, not a boolean we narrow on
    }

    case 'BinaryExpression': {
      const op = node.operator;
      if (op === '===' || op === '==' || op === '!==' || op === '!=') {
        // Strict (`===`/`!==`) compares without coercion; loose (`==`/`!=`) must
        // honor JS type coercion (`0 == false`, `null == undefined`, …) or it
        // would prove a branch dead that actually fires at runtime.
        const loose = op === '==' || op === '!=';
        const eq = equalityTri(node.left, node.right, constEnv, setEnv, loose);
        return op === '!==' || op === '!=' ? notTri(eq) : eq;
      }
      return 'unknown'; // ordering/arithmetic over sets: not supported (sound ⊤)
    }

    default:
      return 'unknown';
  }
}

/**
 * `a === b` over the value sets, sound and three-valued.  Only the
 * "set-var vs literal" (and constant-vs-constant) shapes are decided; anything
 * else is `unknown` so the branch survives.
 */
function equalityTri(
  left: AnyNode | undefined,
  right: AnyNode | undefined,
  constEnv: Map<string, Literal>,
  setEnv: Map<string, Literal[]>,
  loose: boolean,
): Tri {
  // One side a set-var, the other a proven literal -> compare against the set.
  const lset = setVar(left, setEnv);
  const rlit = evaluate(right, constEnv);
  if (lset && rlit.known) return matchTri(lset, rlit.value, loose);

  const rset = setVar(right, setEnv);
  const llit = evaluate(left, constEnv);
  if (rset && llit.known) return matchTri(rset, llit.value, loose);

  // Both sides constant-foldable -> exact answer (covers literal vs literal),
  // honoring the operator's own equality semantics (strict vs loose).
  if (llit.known && rlit.known) return loose ? llit.value == rlit.value : llit.value === rlit.value;

  return 'unknown';
}

/**
 * The reachable value set for `node` if it is a bare set-var identifier, else
 * `null`.  The single definition of "a bare narrowable prop reference": the
 * set-aware predicate here, CSS class enumeration (css.ts), and interprocedural
 * set pass-through (analyze.ts) all decide it through this, so they stay in lockstep.
 */
export function setVar(
  node: AnyNode | undefined,
  setEnv: ReadonlyMap<string, Literal[]>,
): Literal[] | null {
  // A `variant as const` / `variant!` reference is still a bare read of `variant`
  // (the assertion erases at runtime), so it narrows like the identifier it wraps.
  const bare = unwrapTsAssertions(node);
  if (bare?.type === 'Identifier' && bare.name && setEnv.has(bare.name))
    return setEnv.get(bare.name)!;
  return null;
}

/**
 * Is `lit` equal to every / some / no member of the reachable set?  `loose`
 * selects JS coercing `==` (e.g. `0 == false`, `null == undefined`) vs strict
 * `===`; using the wrong one would prove a branch dead that actually fires
 * (`{0,1}` with `n == false` really matches `0`).  `Object.is` is wrong for both
 * (`-0`/`NaN`), so we use the value operators directly.
 */
function matchTri(set: Literal[], lit: Literal, loose: boolean): Tri {
  // The loose branch intentionally uses `==` to model JS coercion.
  const eq = loose ? (v: Literal) => v == lit : (v: Literal) => v === lit;
  if (!set.some(eq)) return false; // lit ∉ set -> never equal
  if (set.every(eq)) return true; // set ⊆ {lit} -> always equal
  return 'unknown'; // some equal, some not -> depends on the runtime value
}

function notTri(t: Tri): Tri {
  if (t === true) return false;
  if (t === false) return true;
  return 'unknown';
}

function andTri(a: Tri, b: Tri): Tri {
  if (a === false || b === false) return false;
  if (a === true && b === true) return true;
  return 'unknown';
}

function orTri(a: Tri, b: Tri): Tri {
  if (a === true || b === true) return true;
  if (a === false && b === false) return false;
  return 'unknown';
}
