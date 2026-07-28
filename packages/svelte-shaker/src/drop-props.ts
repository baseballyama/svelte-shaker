// ----------------------------------------------------------------------
// `$props()` signature slimming: remove the folded / unread props from a
// component's destructuring pattern (and its TS annotation), tiling consecutive
// drops so the separating commas stay valid.
// ----------------------------------------------------------------------

import type MagicString from 'magic-string';
import { isSpace, type AnyNode } from './parse.js';
import { hasUnrepresentableKey, type FileModel } from './model.js';

export function dropProps(model: FileModel, drop: Set<string>, s: MagicString): void {
  if (!model.props || drop.size === 0) return;
  const remaining = model.props.filter((p) => !drop.has(p.name));

  // `props` holds only the identifier-keyed properties, so "nothing remains" does
  // NOT mean the pattern is empty: a string-literal / computed key (`{ 'ns:x': v }`)
  // is invisible to the count, and deleting the whole declaration would silently
  // turn its binding into an undefined global — code that still compiles.  Those
  // patterns fall through to the per-run removal below, which tiles over the FULL
  // property list and so leaves the unrepresentable one in place.
  if (
    remaining.length === 0 &&
    !model.hasRestProp &&
    !hasUnrepresentableKey(model.propsPattern) &&
    model.propsDeclaration
  ) {
    removeWholeLine(model.code, model.propsDeclaration, s); // signature is now empty
    return;
  }
  const properties = model.propsPattern?.properties ?? [];
  // Remove each MAXIMAL RUN of consecutive dropped properties as a single range so
  // the separating commas tile cleanly.  A per-property removal mishandles a
  // trailing comma on the last property and overlaps on consecutive drops, leaving
  // a dangling `,` (invalid `$props()` destructuring).
  const droppedNodes = new Set(model.props.filter((p) => drop.has(p.name)).map((p) => p.property));
  let i = 0;
  while (i < properties.length) {
    if (!droppedNodes.has(properties[i]!)) {
      i++;
      continue;
    }
    let hi = i;
    while (hi + 1 < properties.length && droppedNodes.has(properties[hi + 1]!)) hi++;
    removePropertyRun(model.code, properties, i, hi, s);
    i = hi + 1;
  }
  // Type members live in the disjoint `}: { … }` annotation; remove them per-prop.
  if (model.propsPattern) {
    for (const decl of model.props) {
      if (drop.has(decl.name)) removeTypeMember(model.propsPattern, decl.name, s);
    }
  }
}

/**
 * Delete the run of dropped destructuring properties `properties[lo..hi]` together,
 * absorbing the commas/whitespace so the result stays valid.  When a surviving
 * property follows the run we eat forward to it; otherwise the run reaches the end,
 * so we eat any trailing comma and reach back to the previous surviving property's
 * separator (leaving it with no dangling comma).
 */
function removePropertyRun(
  code: string,
  properties: AnyNode[],
  lo: number,
  hi: number,
  s: MagicString,
): void {
  const first = properties[lo]!;
  const last = properties[hi]!;
  const keptAfter = properties[hi + 1];
  if (keptAfter) {
    s.remove(first.start, keptAfter.start); // run + commas + ws up to the next survivor
    return;
  }
  // Run reaches the end of the pattern: include a trailing comma after the last
  // dropped property if present (so it does not dangle), but NOT the whitespace
  // before `}` when there is none — keep `{ a }` from becoming `{ a}`.  Then drop
  // back to the previous survivor's separator.
  let end = last.end;
  let j = end;
  while (j < code.length && isSpace(code[j]!)) j++;
  if (code[j] === ',') end = j + 1;
  const keptBefore = properties[lo - 1];
  s.remove(keptBefore ? keptBefore.end : first.start, end);
}

function removeTypeMember(pattern: AnyNode, name: string, s: MagicString): void {
  const members = pattern.typeAnnotation?.typeAnnotation?.members ?? [];
  const i = members.findIndex((m) => m.key?.type === 'Identifier' && m.key.name === name);
  if (i === -1) return;
  const member = members[i]!;
  const next = members[i + 1];
  const prev = members[i - 1];
  // Members are separated by `;` or `,`; eat one separator with the member.
  if (next) s.remove(member.start, next.start);
  else if (prev) s.remove(prev.end, member.end);
  else s.remove(member.start, member.end);
}

/**
 * Remove the (now prop-less) `$props()` declaration.  When it is alone on its
 * line — the realistic case for every `.svelte` file — eat the whole line so no
 * blank indentation is left behind.  But if it shares its line with other code
 * (e.g. a hand-minified `let {x}=$props();</script>`), remove ONLY the
 * declaration (plus a trailing `;`) so we never swallow adjacent source.
 */
function removeWholeLine(code: string, node: AnyNode, s: MagicString): void {
  let lineStart = node.start;
  while (lineStart > 0 && code[lineStart - 1] !== '\n') lineStart -= 1;
  let lineEnd = node.end;
  while (lineEnd < code.length && code[lineEnd] !== '\n') lineEnd += 1;

  const prefix = code.slice(lineStart, node.start);
  const suffix = code.slice(node.end, lineEnd);
  if (/^\s*$/.test(prefix) && /^\s*;?\s*$/.test(suffix)) {
    // Alone on the line: remove the line and its trailing newline.
    s.remove(lineStart, lineEnd < code.length ? lineEnd + 1 : lineEnd);
  } else {
    // Shares the line: remove just the declaration (+ a trailing semicolon).
    s.remove(node.start, code[node.end] === ';' ? node.end + 1 : node.end);
  }
}
