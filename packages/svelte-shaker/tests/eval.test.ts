import { describe, expect, it } from 'vitest';
import { evaluateWithSets } from '../src/eval';
import { parseSvelte, type AnyNode } from '../src/parse';
import type { Literal } from '../src/ir';

/** Parse a bare JS expression by wrapping it in a Svelte `{ … }` tag. */
function expr(src: string): AnyNode {
  const ast = parseSvelte(`{${src}}`, 'expr.svelte');
  const tag = ast.fragment.nodes?.find((n) => n.type === 'ExpressionTag');
  if (!tag?.expression) throw new Error(`no expression in {${src}}`);
  return tag.expression;
}

const consts = (o: Record<string, Literal>) => new Map(Object.entries(o));
const sets = (o: Record<string, Literal[]>) => new Map(Object.entries(o));

/**
 * The L1.5 set-aware predicate must be SOUND: it may only return a known boolean
 * when that boolean holds for EVERY value in every prop's reachable set. A value
 * reachable through the set must leave the branch live (`{ known:false }`).
 */
describe('evaluateWithSets (L1.5 set-aware predicate)', () => {
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
