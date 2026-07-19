//! Source-level transform + emit (docs/RUST-MIGRATION.md M5): the Rust port of
//! transform.ts + css.ts. It edits the original `.svelte` source by surgical span
//! removal/overwrite — the `magic-string` counterpart is `MagicEdit` below.

/// A minimal `magic-string` equivalent: records non-overlapping span edits and
/// renders the result. Offsets are **UTF-16 code units** (JS string indices, what
/// the Svelte AST and magic-string use), so editing is correct for non-ASCII
/// source — not just ASCII. Only the ops the always-on-folds transform needs are
/// provided (remove / overwrite); inserts (appendLeft/prepend) are monomorphization-only.
pub struct MagicEdit {
    source: Vec<u16>,
    /// `(start, end, replacement)`; `remove` is `overwrite` with an empty string.
    edits: Vec<(usize, usize, Vec<u16>)>,
    /// `appendLeft` insertions: `(index, content)`, emitted just before the
    /// original unit at `index` (left of the chunk starting there), in call order.
    /// Used by monomorphization's call-site rewrite to inject variant imports.
    inserts: Vec<(usize, Vec<u16>)>,
    /// `prepend` content, prepended to the very front (last call is outermost).
    prepend_buf: Vec<u16>,
}

impl MagicEdit {
    pub fn new(source: &str) -> MagicEdit {
        MagicEdit {
            source: source.encode_utf16().collect(),
            edits: Vec::new(),
            inserts: Vec::new(),
            prepend_buf: Vec::new(),
        }
    }

    pub fn remove(&mut self, start: usize, end: usize) {
        self.edits.push((start, end, Vec::new()));
    }

    pub fn overwrite(&mut self, start: usize, end: usize, content: &str) {
        self.edits.push((start, end, content.encode_utf16().collect()));
    }

    /// Insert `content` immediately before the original unit at `index` (magic-string
    /// `appendLeft`).  Repeated calls at the same index keep call order.
    pub fn append_left(&mut self, index: usize, content: &str) {
        self.inserts.push((index, content.encode_utf16().collect()));
    }

    /// Prepend `content` to the very front (magic-string `prepend`); the last call
    /// ends up outermost.
    pub fn prepend(&mut self, content: &str) {
        let mut buf: Vec<u16> = content.encode_utf16().collect();
        buf.extend_from_slice(&self.prepend_buf);
        self.prepend_buf = buf;
    }

    /// Source length in UTF-16 code units (for end-of-source fallbacks).
    pub fn len(&self) -> usize {
        self.source.len()
    }

    /// The original char at a UTF-16 index, if any (for whitespace-eating).
    pub fn unit_at(&self, index: usize) -> Option<u16> {
        self.source.get(index).copied()
    }

    /// The original source between two UTF-16 indices (for re-emitting verbatim).
    pub fn slice(&self, start: usize, end: usize) -> String {
        let end = end.min(self.source.len());
        if start >= end {
            return String::new();
        }
        String::from_utf16_lossy(&self.source[start..end])
    }

    pub fn render(&self) -> String {
        // magic-string semantics: a later operation wins over an earlier one on an
        // overlapping range (e.g. a `drop` that removes a whole `$props()` property
        // supersedes an earlier `substitute` overwrite of the prop key inside it).
        // So discard any edit overlapped by a LATER-inserted edit; the survivors
        // are then pairwise disjoint.
        let n = self.edits.len();
        let mut superseded = vec![false; n];
        for i in 0..n {
            let (s1, e1, _) = &self.edits[i];
            for later in &self.edits[i + 1..] {
                let (s2, e2, _) = later;
                if s1 < e2 && s2 < e1 {
                    superseded[i] = true;
                    break;
                }
            }
        }
        let mut active: Vec<&(usize, usize, Vec<u16>)> =
            self.edits.iter().enumerate().filter(|(i, _)| !superseded[*i]).map(|(_, e)| e).collect();
        active.sort_by_key(|e| e.0);

        // `appendLeft` insertions, stable-sorted by index (call order preserved on ties).
        let mut inserts: Vec<&(usize, Vec<u16>)> = self.inserts.iter().collect();
        inserts.sort_by_key(|e| e.0);

        let mut out: Vec<u16> = Vec::with_capacity(self.source.len());
        out.extend_from_slice(&self.prepend_buf);
        let mut cursor = 0usize;
        let mut si = 0usize;
        let mut ii = 0usize;
        // Merge span edits and point insertions in source order.  On a tie at index
        // `p`, the insertion is emitted first (`appendLeft` attaches left of the
        // chunk that a span edit at `p` would replace).
        loop {
            let span_start = active.get(si).map(|e| e.0);
            let ins_idx = inserts.get(ii).map(|e| e.0);
            let take_insert = match (ins_idx, span_start) {
                (Some(p), Some(s)) => p <= s,
                (Some(_), None) => true,
                _ => false,
            };
            if take_insert {
                let (p, content) = inserts[ii];
                if *p >= cursor {
                    out.extend_from_slice(&self.source[cursor..*p]);
                    cursor = *p;
                }
                out.extend_from_slice(content);
                ii += 1;
            } else if let Some((start, end, content)) = active.get(si).copied() {
                si += 1;
                if *start < cursor {
                    continue; // survivors are disjoint; this is a defensive backstop
                }
                out.extend_from_slice(&self.source[cursor..*start]);
                out.extend_from_slice(content);
                cursor = *end;
            } else {
                break;
            }
        }
        out.extend_from_slice(&self.source[cursor..]);
        String::from_utf16_lossy(&out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remove_and_overwrite_ascii() {
        let mut s = MagicEdit::new("hello world");
        s.overwrite(0, 5, "HI"); // "hello" -> "HI"
        s.remove(5, 6); // drop the space
        assert_eq!(s.render(), "HIworld");
    }

    #[test]
    fn untouched_is_identity() {
        let s = MagicEdit::new("{#if x}<p>a</p>{/if}");
        assert_eq!(s.render(), "{#if x}<p>a</p>{/if}");
    }

    #[test]
    fn offsets_are_utf16_units_not_bytes() {
        // "あ" is one UTF-16 unit but three UTF-8 bytes; a byte-indexed editor
        // would slice mid-codepoint. After "あ" (index 1) delete "XY" (1..3).
        let mut s = MagicEdit::new("あXYい");
        s.remove(1, 3);
        assert_eq!(s.render(), "あい");
    }

    #[test]
    fn adjacent_edits_compose() {
        let mut s = MagicEdit::new("abcdef");
        s.overwrite(1, 2, "B");
        s.remove(3, 5); // drop "de"
        assert_eq!(s.render(), "aBcf");
    }

    #[test]
    fn append_left_inserts_before_index() {
        let mut s = MagicEdit::new("abcdef");
        s.append_left(3, "XY"); // before 'd'
        assert_eq!(s.render(), "abcXYdef");
    }

    #[test]
    fn prepend_goes_to_front_and_composes_with_edits() {
        let mut s = MagicEdit::new("abcdef");
        s.prepend("<<");
        s.overwrite(0, 1, "A"); // 'a' -> 'A'
        assert_eq!(s.render(), "<<Abcdef");
    }

    #[test]
    fn append_left_coexists_with_a_later_span_edit() {
        let mut s = MagicEdit::new("abcdef");
        s.append_left(6, ";import"); // at end of source
        s.remove(1, 2); // drop 'b'
        assert_eq!(s.render(), "acdef;import");
    }
}
