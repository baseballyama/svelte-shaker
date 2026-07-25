//! Source-level transform + emit (docs/RUST-MIGRATION.md M5): the Rust port of
//! transform.ts + css.ts. It edits the original `.svelte` source by surgical span
//! removal/overwrite — the `magic-string` counterpart is `MagicEdit` below.

/// A minimal `magic-string` equivalent: records span edits (which MAY overlap) and
/// renders them with magic-string's chunk semantics (see `render`). Offsets are
/// **UTF-16 code units** (JS string indices, what the Svelte AST and magic-string
/// use), so editing is correct for non-ASCII source — not just ASCII. Only the ops
/// the always-on-folds transform needs are provided (remove / overwrite); inserts
/// (appendLeft/prepend) are monomorphization-only.
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
        // Faithful magic-string chunk model. Split the source into ATOMIC segments at
        // every edit boundary, then replay the edits in CALL ORDER: a `remove` empties
        // every segment it covers; an `overwrite` empties them too but anchors its
        // content on the first (magic-string keeps the replacement on the range's first
        // chunk and empties the rest). This reproduces magic-string — hence the TS
        // `magic-string` engine — byte-for-byte on the overlaps the engine produces:
        //  - Two overlapping REMOVES UNION (magic-string splits the already-emptied
        //    chunk and empties the remainder). `remove_type_member` emits exactly such a
        //    pair when it drops the LAST type member whose predecessor is also dropped
        //    (`[a.start, b.start)` then `[a.end, b.end)`); the old "later edit supersedes
        //    the earlier" rule dropped the earlier remove whole, leaving the predecessor
        //    member behind (a native/TS divergence).
        //  - A later edit that fully re-covers an earlier one wins (a `drop` removing a
        //    whole `$props()` property empties the segment holding an earlier
        //    `substitute` overwrite of the key inside it — content gone), as magic-string does.
        let len = self.source.len();
        // Segment boundaries: 0, len, and every edit's clamped start/end.
        let mut bounds: Vec<usize> = Vec::with_capacity(self.edits.len() * 2 + 2);
        bounds.push(0);
        bounds.push(len);
        for (s, e, _) in &self.edits {
            bounds.push((*s).min(len));
            bounds.push((*e).min(len));
        }
        bounds.sort_unstable();
        bounds.dedup();
        let seg_count = bounds.len().saturating_sub(1);
        // Per atomic segment: `None` = emit the original source slice; `Some(bytes)` =
        // edited (empty for a removal, the replacement for an overwrite's first chunk).
        let mut seg_out: Vec<Option<Vec<u16>>> = vec![None; seg_count];
        for (s, e, content) in &self.edits {
            let s = (*s).min(len);
            let e = (*e).min(len);
            if s >= e {
                continue; // zero-width span: no chunk to edit (inserts carry appendLeft)
            }
            // The first covered segment starts exactly at `s` (a boundary), so its index
            // is `s`'s position in the deduped, sorted `bounds`.
            let lo = bounds.binary_search(&s).unwrap_or_else(|i| i);
            let mut k = lo;
            let mut first = true;
            while k < seg_count && bounds[k] < e {
                seg_out[k] = Some(if first && !content.is_empty() { content.clone() } else { Vec::new() });
                first = false;
                k += 1;
            }
        }
        // Edited segments in source order; original (untouched) segments are filled from
        // the source by the merge loop's gap emission below. Disjoint by construction.
        let active: Vec<(usize, usize, &[u16])> = (0..seg_count)
            .filter_map(|k| seg_out[k].as_ref().map(|b| (bounds[k], bounds[k + 1], b.as_slice())))
            .collect();

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
            } else if let Some(&(start, end, content)) = active.get(si) {
                si += 1;
                out.extend_from_slice(&self.source[cursor..start]);
                out.extend_from_slice(content);
                cursor = end;
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
    fn later_overlapping_edit_supersedes_earlier() {
        // magic-string: the later-recorded overwrite of an overlapping range wins.
        let mut s = MagicEdit::new("0123456789");
        s.overwrite(2, 8, "X"); // earlier
        s.overwrite(0, 10, "Y"); // later, contains the first -> supersedes it
        assert_eq!(s.render(), "Y");
    }

    #[test]
    fn partially_overlapping_removes_union() {
        // magic-string: two `remove`s that partially overlap UNION — it splits the
        // already-emptied chunk and empties the remainder, so the removed region is
        // `[min(start), max(end))`. This is exactly the pair `remove_type_member` emits
        // when it drops the LAST type member whose predecessor is also dropped
        // (`[a.start, b.start)` then `[a.end, b.end)`); the removed span must cover both
        // members, not just the later one. Regression for the native-engine bug where
        // the dropped predecessor member was left behind.
        let mut s = MagicEdit::new("0123456789");
        s.remove(2, 6); // idx0: [2,6)
        s.remove(4, 8); // idx1: [4,8), overlaps -> union [2,8)
        assert_eq!(s.render(), "0189");
    }

    #[test]
    fn later_remove_empties_an_earlier_overwrite_it_covers() {
        // The real engine overlap (docs): a `drop` removing a whole `$props()` property
        // empties the segment holding an earlier `substitute` overwrite of the key
        // inside it — so the substituted content is gone, matching magic-string.
        let mut s = MagicEdit::new("0123456789");
        s.overwrite(3, 5, "XX"); // idx0: substitute inside the property
        s.remove(2, 7); // idx1: drop the whole property, covering the overwrite
        assert_eq!(s.render(), "01789");
    }

    #[test]
    fn append_left_coexists_with_a_later_span_edit() {
        let mut s = MagicEdit::new("abcdef");
        s.append_left(6, ";import"); // at end of source
        s.remove(1, 2); // drop 'b'
        assert_eq!(s.render(), "acdef;import");
    }
}
