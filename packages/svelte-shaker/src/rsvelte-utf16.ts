// UTF-8 byte offset -> UTF-16 code-unit offset remap for rsvelte's serialized AST.
//
// rsvelte (`@rsvelte/compiler`) reports every AST position as a UTF-8 *byte*
// offset, but svelte/compiler — and therefore this engine's transform, which
// drives `magic-string` with `start`/`end` — expects UTF-16 *code-unit* offsets.
// For any source with a non-ASCII character before a position the two disagree,
// so a raw rsvelte AST makes the transform splice at the wrong index: it crashes
// (`MagicString: end is out of bounds`) when the drift is large, or silently
// corrupts output when it is small. rsvelte's own byte->UTF-16 conversion is a
// private (`pub(crate)`) API we cannot call, so we reproduce it here (a faithful
// port of `engine-scan-native/src/utf16.rs`). Only non-ASCII sources need it;
// ASCII sources already coincide in both encodings and skip it for free.
//
// When bumping `@rsvelte/compiler`, re-verify that its AST offsets are still
// UTF-8 bytes — a future version may switch to UTF-16 and turn this into a
// double conversion.

/** The offset keys rsvelte serializes as absolute UTF-8 byte positions. */
const BYTE_OFFSET_KEYS = ['start', 'end', 'character'] as const;

/** Matches any non-ASCII UTF-16 code unit (>= U+0080, surrogates included). */
const NON_ASCII = /[\u0080-\uFFFF]/;

/**
 * Byte -> UTF-16 position table for one source string. Built in a single
 * O(bytes) pass; every lookup is O(1), so remapping the whole AST is O(nodes).
 */
class Utf8ToUtf16 {
  /** For each byte offset `b` in `0..=byteLength`, the UTF-16 offset at `b`. */
  private readonly utf16Pos: number[];
  /** Byte offset of each line start (parallel to `lineStartsUtf16`). */
  private readonly lineStartsByte: number[];
  /** UTF-16 offset of each line start. */
  private readonly lineStartsUtf16: number[];

  constructor(source: string) {
    const utf16Pos: number[] = [];
    const lineStartsByte = [0];
    const lineStartsUtf16 = [0];
    let utf16Idx = 0;
    let byteIdx = 0;

    // `for..of` iterates by Unicode code point, so `ch.length` is the UTF-16
    // width (2 for astral code points) and the code point value gives the UTF-8
    // width.
    for (const ch of source) {
      const cp = ch.codePointAt(0)!;
      const utf8Len = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
      const utf16Len = ch.length;
      for (let i = 0; i < utf8Len; i++) utf16Pos.push(utf16Idx);
      utf16Idx += utf16Len;
      byteIdx += utf8Len;
      if (ch === '\n') {
        lineStartsByte.push(byteIdx);
        lineStartsUtf16.push(utf16Idx);
      }
    }
    utf16Pos.push(utf16Idx);

    this.utf16Pos = utf16Pos;
    this.lineStartsByte = lineStartsByte;
    this.lineStartsUtf16 = lineStartsUtf16;
  }

  /** Convert an absolute UTF-8 byte offset to a UTF-16 code-unit offset. */
  convert(bytePos: number): number {
    return bytePos >= this.utf16Pos.length
      ? this.utf16Pos[this.utf16Pos.length - 1]!
      : this.utf16Pos[bytePos]!;
  }

  /** Convert a 0-based byte column on a 1-based line to a UTF-16 column. */
  convertColumn(line: number, byteColumn: number): number {
    if (line === 0 || line > this.lineStartsByte.length) return byteColumn;
    const lineStartByte = this.lineStartsByte[line - 1]!;
    const lineStartUtf16 = this.lineStartsUtf16[line - 1]!;
    const absUtf16 = this.convert(lineStartByte + byteColumn);
    return Math.max(0, absUtf16 - lineStartUtf16);
  }
}

/** Recursively remap every byte offset (and `loc` `column`) in `value`, in place. */
function convertPositions(value: unknown, conv: Utf8ToUtf16): void {
  if (Array.isArray(value)) {
    for (const item of value) convertPositions(item, conv);
    return;
  }
  if (value === null || typeof value !== 'object') return;

  const obj = value as Record<string, unknown>;
  for (const key of BYTE_OFFSET_KEYS) {
    const n = obj[key];
    if (typeof n === 'number') obj[key] = conv.convert(n);
  }
  // A `loc` position object carries a byte `column` on a 1-based `line`, which
  // needs the line-relative remap rather than an absolute one.
  const line = obj['line'];
  const column = obj['column'];
  if (typeof line === 'number' && typeof column === 'number') {
    obj['column'] = conv.convertColumn(line, column);
  }
  for (const key of Object.keys(obj)) convertPositions(obj[key], conv);
}

/**
 * Remap every offset in rsvelte's parsed AST from UTF-8 bytes to UTF-16 code
 * units, in place, and return it. A no-op (returns `ast` untouched) when `code`
 * is pure ASCII, since the two encodings then coincide.
 */
export function remapRsvelteOffsets<T>(ast: T, code: string): T {
  if (!NON_ASCII.test(code)) return ast;
  convertPositions(ast, new Utf8ToUtf16(code));
  return ast;
}
