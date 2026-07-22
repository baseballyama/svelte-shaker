import { describe, expect, it } from 'vitest';
import { evaluate, evaluateWithSets, unwrapTsAssertions } from '../src/eval';
import { tryLoadRsvelteParser } from '../src/rsvelte-parse';
import { parseSvelte, type AnyNode } from '../src/parse';
import type { Literal } from '../src/ir';

/** Parse a bare JS expression by wrapping it in a Svelte `{ … }` tag. */
function expr(src: string): AnyNode {
  const ast = parseSvelte(`{${src}}`, 'expr.svelte');
  const tag = ast.fragment.nodes?.find((n) => n.type === 'ExpressionTag');
  if (!tag?.expression) throw new Error(`no expression in {${src}}`);
  return tag.expression;
}

/** Parse a TS expression (with `as`/`satisfies`/`!`) via a `lang="ts"` script
 * initializer, returning its declarator `init` node — the only context where the
 * svelte parser produces `TSAsExpression` / `TSNonNullExpression` / … nodes. */
function tsExpr(src: string): AnyNode {
  const ast = parseSvelte(`<script lang="ts">let _x = ${src};</script>`, 'expr.svelte');
  const init = ast.instance?.content?.body?.[0]?.declarations?.[0]?.init;
  if (!init) throw new Error(`no initializer in ${src}`);
  return init;
}

const consts = (o: Record<string, Literal>) => new Map(Object.entries(o));
const sets = (o: Record<string, Literal[]>) => new Map(Object.entries(o));

/**
 * The value-set narrowing set-aware predicate must be SOUND: it may only return a known boolean
 * when that boolean holds for EVERY value in every prop's reachable set. A value
 * reachable through the set must leave the branch live (`{ known:false }`).
 */
describe('evaluateWithSets (value-set narrowing set-aware predicate)', () => {
  const variant = sets({ variant: ['primary', 'secondary'] });
  const empty = consts({});

  it('x === lit is provably FALSE when lit ∉ set(x)', () => {
    expect(evaluateWithSets(expr("variant === 'danger'"), empty, variant)).toEqual({
      known: true,
      value: false,
    });
    expect(evaluateWithSets(expr("variant == 'danger'"), empty, variant)).toEqual({
      known: true,
      value: false,
    });
  });

  it('x === lit is UNKNOWN when lit is one of several reachable values', () => {
    // `variant` can be 'primary' OR 'secondary', so neither branch is provable.
    expect(evaluateWithSets(expr("variant === 'primary'"), empty, variant).known).toBe(false);
    expect(evaluateWithSets(expr("variant === 'secondary'"), empty, variant).known).toBe(false);
  });

  it('x === lit is provably TRUE only when set(x) ⊆ {lit} (singleton)', () => {
    const single = sets({ v: ['only'] });
    expect(evaluateWithSets(expr("v === 'only'"), empty, single)).toEqual({
      known: true,
      value: true,
    });
  });

  it('x !== lit negates the equality result', () => {
    // danger ∉ set -> `!==` is provably TRUE.
    expect(evaluateWithSets(expr("variant !== 'danger'"), empty, variant)).toEqual({
      known: true,
      value: true,
    });
    expect(evaluateWithSets(expr("variant != 'danger'"), empty, variant)).toEqual({
      known: true,
      value: true,
    });
    // primary is reachable -> `!==` is UNKNOWN.
    expect(evaluateWithSets(expr("variant !== 'primary'"), empty, variant).known).toBe(false);
  });

  it('combines via && / || / ! soundly (Kleene)', () => {
    // false && unknown -> provably false (danger arm can never fire).
    expect(
      evaluateWithSets(expr("variant === 'danger' && variant === 'primary'"), empty, variant),
    ).toEqual({ known: true, value: false });
    // true || unknown -> provably true (danger is impossible, so `!== danger`).
    expect(
      evaluateWithSets(expr("variant !== 'danger' || variant === 'primary'"), empty, variant),
    ).toEqual({ known: true, value: true });
    // !(provably false) -> provably true.
    expect(evaluateWithSets(expr("!(variant === 'danger')"), empty, variant)).toEqual({
      known: true,
      value: true,
    });
    // unknown || unknown -> UNKNOWN (both arms reachable).
    expect(
      evaluateWithSets(expr("variant === 'primary' || variant === 'secondary'"), empty, variant)
        .known,
    ).toBe(false);
  });

  it('still folds pure constants and constFold props', () => {
    expect(evaluateWithSets(expr('1 + 1 === 2'), empty, variant)).toEqual({
      known: true,
      value: true,
    });
    expect(evaluateWithSets(expr("size === 'lg'"), consts({ size: 'lg' }), variant)).toEqual({
      known: true,
      value: true,
    });
  });

  it('does not guess on unsupported shapes (ordering / arithmetic over sets)', () => {
    const nums = sets({ n: [1, 2] });
    expect(evaluateWithSets(expr('n > 0'), empty, nums).known).toBe(false);
    expect(evaluateWithSets(expr('n + 1 === 2'), empty, nums).known).toBe(false);
  });
});

/**
 * `evaluate` is the only door through which a parsed value enters the engine, so
 * it is where the {@link Literal} union is enforced.  A value it
 * admits gets substituted into source verbatim; one it cannot represent
 * faithfully must stay unknown, costing a fold instead of changing a render.
 */
describe('evaluate (literal value domain)', () => {
  const rsvelte = tryLoadRsvelteParser();

  /** Parse a bare JS expression with the rsvelte parser (JSON AST transport). */
  function rsExpr(src: string): AnyNode {
    const ast = rsvelte!(`{${src}}`, 'expr.svelte');
    const tag = ast.fragment.nodes?.find((n) => n.type === 'ExpressionTag');
    if (!tag?.expression) throw new Error(`no expression in {${src}}`);
    return tag.expression;
  }

  const empty = consts({});

  // A regex is parenthesized because a bare `{/` opens a block CLOSING tag.
  it('rejects BigInt and RegExp literals', () => {
    // `JSON.stringify` throws on the first and yields `{}` for the second.
    expect(evaluate(expr('1n'), empty).known).toBe(false);
    expect(evaluate(expr('(/ab+c/g)'), empty).known).toBe(false);
  });

  it.skipIf(!rsvelte)('rejects them under the rsvelte parser too', () => {
    expect(evaluate(rsExpr('(/ab+c/g)'), empty).known).toBe(false);
    expect(evaluate(rsExpr('1n'), empty).known).toBe(false);
  });

  it('rejects a number literal that cannot survive JSON transport', () => {
    // rsvelte's AST crosses a WASM boundary as JSON, where `1e999` (Infinity)
    // arrives as `value: null` — a genuine `null` except for `raw`.
    if (rsvelte) expect(evaluate(rsExpr('1e999'), empty).known).toBe(false);
    expect(evaluate(expr('1e999'), empty)).toEqual({ known: true, value: Infinity });
  });

  it('still folds a genuine `null` and computed non-finite numbers', () => {
    expect(evaluate(expr('null'), empty)).toEqual({ known: true, value: null });
    if (rsvelte) expect(evaluate(rsExpr('null'), empty)).toEqual({ known: true, value: null });
    expect(evaluate(expr('1 / 0'), empty)).toEqual({ known: true, value: Infinity });
    expect(evaluate(expr('0 / 0'), empty)).toEqual({ known: true, value: NaN });
  });
});

/**
 * TypeScript assertion expressions (`x as T`, `x!`, `x satisfies T`) are
 * compile-time-only type operators that erase to their operand at runtime, so the
 * evaluator must see through them and fold the wrapped value — otherwise a
 * `<script lang="ts">` AST (which svelte/compiler keeps these nodes in) folds less
 * than a parser that strips them, breaking parser-neutrality (issue #150).
 */
describe('evaluate: TypeScript assertion unwrapping (issue #150)', () => {
  it("folds `'chips' as const` (TSAsExpression) to the literal", () => {
    expect(evaluate(tsExpr("'chips' as const"), new Map())).toEqual({
      known: true,
      value: 'chips',
    });
  });

  it('folds `x!` (TSNonNullExpression) through the env', () => {
    expect(evaluate(tsExpr('x!'), consts({ x: 7 }))).toEqual({ known: true, value: 7 });
  });

  it('folds `x satisfies T` (TSSatisfiesExpression)', () => {
    expect(evaluate(tsExpr("'ok' satisfies string"), new Map())).toEqual({
      known: true,
      value: 'ok',
    });
  });

  it("peels nested assertions `('a' as const)!` down to the operand", () => {
    expect(evaluate(tsExpr("('a' as const)!"), new Map())).toEqual({ known: true, value: 'a' });
    expect(unwrapTsAssertions(tsExpr("('a' as const)!"))?.type).toBe('Literal');
  });

  it('a TS assertion wrapping a non-constant identifier stays UNKNOWN', () => {
    // `dynamic` is not in the env, so the assertion cannot manufacture a value.
    expect(evaluate(tsExpr('dynamic as string'), new Map()).known).toBe(false);
    expect(unwrapTsAssertions(tsExpr('dynamic as string'))?.type).toBe('Identifier');
  });
});
