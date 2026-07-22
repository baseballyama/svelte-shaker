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
  /** MemberExpression object (`$state` in `$state.raw`). */
  object?: AnyNode | undefined;
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
  /** CallExpression / NewExpression arguments (`0` in `$state(0)`). */
  arguments?: (AnyNode | null)[] | undefined;
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
  /** ObjectExpression `Property` accessor kind (`init` / `get` / `set`). */
  kind?: string | undefined;
  /** ObjectExpression `Property` shorthand-method flag (`{ m() {} }`). */
  method?: boolean | undefined;

  /** ESTree `Literal` discriminators, present only on a RegExp (`/x/g`) or
   * BigInt (`1n`) literal — neither of which carries a foldable `value`. */
  regex?: { pattern: string; flags: string } | undefined;
  bigint?: string | undefined;

  value?: unknown;
}

export interface Root extends AnyNode {
  fragment: AnyNode;
}

export function parseSvelte(code: string, filename: string): Root {
  return parse(code, { modern: true, filename }) as unknown as Root;
}

/** Matches every `</script` in module text (any case), the sequence that would
 * otherwise close the {@link parseModuleProgram} wrapper early. */
const CLOSING_SCRIPT = /<\/script/gi;

/** What `CLOSING_SCRIPT` is rewritten to: a space after the `<` breaks the
 * `</script\s*>` the Svelte parser scans for, while staying a recognizable
 * marker so a corrupted specifier can be detected afterwards. */
const NEUTRALIZED_SCRIPT = '< /script';

/**
 * Parse a plain `.js`/`.ts` module (NOT a `.svelte` component) and return its
 * top-level ESTree Program, or `null` if it does not parse.  The engine has no
 * standalone JS parser, so we reuse the Svelte parser via a `<script module
 * lang="ts">` wrapper: `lang="ts"` is what lets a TypeScript barrel — `export
 * type { … }`, type-only specifiers, annotations, the norm for a design-system
 * `index.ts` — parse where a plain-JS parse would throw.
 *
 * The Svelte parser ends a `<script>` at the first `</script…>` it finds in the
 * RAW text (`read_until(/<\/script\s*>/)`), so a valid module whose text merely
 * MENTIONS `</script>` — in a comment, string, regex or template literal, as an
 * HTML sanitizer or a markdown pipeline routinely does — would close the wrapper
 * early and fail to parse (issue #146).  We break every `</script` in the body
 * before wrapping by inserting a space after the `<`.  In valid JS/TS `</script`
 * only ever occurs inside a comment or a string/regex/template literal (it is
 * never part of executable syntax), so this alters only inert text — with ONE
 * exception a caller does read: a module SPECIFIER that itself contains
 * `</script` (`import x from './a</script>b.js'`).  Rewriting it would silently
 * change which file it resolves to, turning a parse failure into a partial one
 * (a missed escape / an unfollowed export).  Rather than claim such a specifier
 * cannot exist, we detect a rewritten one after parsing and fail the whole
 * module (return `null`), the same loud degrade a parse failure gives — the
 * specifier is absurd (`<`/`>` are invalid in real paths and package names), so
 * this only trades one conservative outcome for another.  The inserted spaces
 * shift byte offsets, but no caller reads spans off this AST — only specifier
 * names and string values.
 *
 * Returns `null` on a genuine parse failure (a JSX body, exotic/bleeding-edge
 * TS) or a specifier the neutralization would corrupt: a call site hidden inside
 * then goes unfollowed, which each caller handles conservatively (escape scan
 * reports the file as unscannable; barrel-following leaves the barrel unfollowed).
 */
export function parseModuleProgram(code: string, filename: string): AnyNode | null {
  const wrapped = `<script module lang="ts">\n${code.replace(CLOSING_SCRIPT, NEUTRALIZED_SCRIPT)}\n</script>`;
  let program: AnyNode | null;
  try {
    program = parseSvelte(wrapped, filename).module?.content ?? null;
  } catch {
    return null; // unparseable — the caller decides how to degrade (see above)
  }
  // A specifier that carried `</script` was rewritten by the neutralization and
  // no longer names the real module; degrade loudly rather than resolve a lie.
  if (program && hasNeutralizedSpecifier(program)) return null;
  return program;
}

/** True when any static import/export/dynamic-`import()` specifier string in
 * `program` contains the {@link NEUTRALIZED_SCRIPT} marker — i.e. the source
 * originally held `</script` and was rewritten by {@link parseModuleProgram}, so
 * it can no longer be trusted to resolve. */
function hasNeutralizedSpecifier(program: AnyNode): boolean {
  let corrupted = false;
  const check = (source: AnyNode | undefined): void => {
    if (
      source?.type === 'Literal' &&
      typeof source.value === 'string' &&
      source.value.includes(NEUTRALIZED_SCRIPT)
    ) {
      corrupted = true;
    }
  };
  walk<null>(program, null, {
    ImportDeclaration(node, { next }) {
      check(node.source);
      next();
    },
    ExportNamedDeclaration(node, { next }) {
      check(node.source);
      next();
    },
    ExportAllDeclaration(node, { next }) {
      check(node.source);
      next();
    },
    ImportExpression(node, { next }) {
      check(node.source);
      next();
    },
  });
  return corrupted;
}

/**
 * Content-keyed parse cache: a hit returns the IDENTICAL AST for unchanged
 * source, so the dev engine re-parses only the files that actually changed
 * (docs/RUST-MIGRATION.md §2.2 — `parse(id)` is the cached input query, the
 * dominant cost an edit avoids).  Keyed by content, so a stale entry can never
 * return an AST whose byte offsets disagree with the source: a code mismatch
 * forces a re-parse.
 */
export type ParseCache = Map<string, { code: string; ast: Root }>;

/**
 * A `.svelte` -> modern-AST parser, swappable for the default {@link parseSvelte}
 * (svelte/compiler).  The engine reads only the AST it returns, so any parser that
 * emits svelte/compiler's modern shape (UTF-16 `start`/`end`) can drive it — the
 * Vite plugin's `parser: 'rsvelte'` option supplies rsvelte's parser (the
 * `@rsvelte/compiler` WASM build) here (docs/RUST-MIGRATION.md §6).
 */
export type Parse = (code: string, filename: string) => Root;

export function parseCached(
  filename: string,
  code: string,
  cache?: ParseCache,
  parse: Parse = parseSvelte,
): Root {
  if (!cache) return parse(code, filename);
  const hit = cache.get(filename);
  if (hit && hit.code === code) return hit.ast;
  const ast = parse(code, filename);
  cache.set(filename, { code, ast });
  return ast;
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
