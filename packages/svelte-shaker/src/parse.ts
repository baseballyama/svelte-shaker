import { parse } from 'svelte/compiler';
import { walk as zfWalk } from 'zimmerframe';

/**
 * A deliberately loose view of the Svelte + ESTree AST: only the fields this
 * engine reads, each optional.  Avoiding an index signature keeps named access
 * compatible with `noPropertyAccessFromIndexSignature` while still letting us
 * walk an untyped tree.  `value` is `unknown` because it means different things
 * on `Literal` (a literal) vs `Attribute` (true | node | node[]).
 */
export interface AnyNode {
  type: string;
  start: number;
  end: number;

  // node-valued
  test?: AnyNode | undefined;
  consequent?: AnyNode | undefined;
  alternate?: AnyNode | null | undefined;
  expression?: AnyNode | undefined;
  argument?: AnyNode | undefined;
  left?: AnyNode | undefined;
  right?: AnyNode | undefined;
  callee?: AnyNode | undefined;
  id?: AnyNode | undefined;
  init?: AnyNode | undefined;
  key?: AnyNode | undefined;
  property?: AnyNode | undefined;
  source?: AnyNode | undefined;
  local?: AnyNode | undefined;
  /** ImportSpecifier / ExportSpecifier exported-name slot. */
  imported?: AnyNode | undefined;
  exported?: AnyNode | undefined;
  typeAnnotation?: AnyNode | undefined;
  content?: AnyNode | undefined;
  fragment?: AnyNode | null | undefined;
  instance?: AnyNode | null | undefined;
  module?: AnyNode | null | undefined;
  css?: AnyNode | null | undefined;
  // Template-block bindings (EachBlock / AwaitBlock / ConstTag).  `index` is a
  // bare string on EachBlock; the rest are nodes/patterns.
  context?: AnyNode | undefined;
  error?: AnyNode | null | undefined;
  then?: AnyNode | null | undefined;
  catch?: AnyNode | null | undefined;
  declaration?: AnyNode | undefined;
  // CSS-valued (svelte/compiler `ast.css`): Rule prelude/block, Atrule block,
  // RelativeSelector combinator, PseudoClassSelector args.
  prelude?: AnyNode | undefined;
  block?: AnyNode | null | undefined;
  combinator?: AnyNode | null | undefined;
  args?: AnyNode | null | undefined;

  // array-valued
  attributes?: AnyNode[] | undefined;
  properties?: AnyNode[] | undefined;
  members?: AnyNode[] | undefined;
  body?: AnyNode[] | undefined;
  declarations?: AnyNode[] | undefined;
  specifiers?: AnyNode[] | undefined;
  nodes?: AnyNode[] | undefined;
  /** SnippetBlock parameters; ArrayPattern elements; DebugTag identifiers. */
  parameters?: AnyNode[] | undefined;
  /** Function / arrow ESTree parameters (`function f(a, b)`, `(a) => …`). */
  params?: AnyNode[] | undefined;
  elements?: (AnyNode | null)[] | undefined;
  identifiers?: AnyNode[] | undefined;
  /** CSS StyleSheet/SelectorList/ComplexSelector children, Block children. */
  children?: AnyNode[] | undefined;
  /** RelativeSelector simple selectors (ClassSelector, TypeSelector, …). */
  selectors?: AnyNode[] | undefined;

  // primitive-valued
  name?: string | undefined;
  /** EachBlock loop index variable name (a bare string, e.g. `i`). */
  index?: string | undefined;
  operator?: string | undefined;
  raw?: string | undefined;
  data?: string | undefined;
  computed?: boolean | undefined;
  shorthand?: boolean | undefined;
  elseif?: boolean | undefined;

  value?: unknown;
}

export interface Root extends AnyNode {
  fragment: AnyNode;
}

export function parseSvelte(code: string, filename: string): Root {
  return parse(code, { modern: true, filename }) as unknown as Root;
}

// ---- typed zimmerframe facade ----------------------------------------

export interface WalkCtx<S> {
  state: S;
  next: (state?: S) => void;
  stop: () => void;
}

export type Visitors<S> = Record<string, (node: AnyNode, ctx: WalkCtx<S>) => void>;

/** `zimmerframe.walk`, narrowed to our loose node type. */
export function walk<S>(root: AnyNode, state: S, visitors: Visitors<S>): void {
  (zfWalk as unknown as (r: AnyNode, s: S, v: Visitors<S>) => void)(root, state, visitors);
}
