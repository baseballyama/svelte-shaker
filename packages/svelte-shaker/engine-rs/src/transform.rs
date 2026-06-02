//! Source-level transform + emit (docs/RUST-MIGRATION.md M5): the Rust port of
//! transform.ts + css.ts. It edits the original `.svelte` source by surgical span
//! removal/overwrite — the `magic-string` counterpart is `MagicEdit` below.

/// A minimal `magic-string` equivalent: records non-overlapping span edits and
/// renders the result. Offsets are **UTF-16 code units** (JS string indices, what
/// the Svelte AST and magic-string use), so editing is correct for non-ASCII
/// source — not just ASCII. Only the ops the L0/L1/L1.5 transform needs are
/// provided (remove / overwrite); inserts (appendLeft/prepend) are L2-only.
pub struct MagicEdit {
    source: Vec<u16>,
    /// `(start, end, replacement)`; `remove` is `overwrite` with an empty string.
    edits: Vec<(usize, usize, Vec<u16>)>,
}

impl MagicEdit {
    pub fn new(source: &str) -> MagicEdit {
        MagicEdit { source: source.encode_utf16().collect(), edits: Vec::new() }
    }

    pub fn remove(&mut self, start: usize, end: usize) {
        self.edits.push((start, end, Vec::new()));
    }

    pub fn overwrite(&mut self, start: usize, end: usize, content: &str) {
        self.edits.push((start, end, content.encode_utf16().collect()));
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

        let mut out: Vec<u16> = Vec::with_capacity(self.source.len());
        let mut cursor = 0usize;
        for (start, end, content) in active {
            if *start < cursor {
                continue; // survivors are disjoint; this is a defensive backstop
            }
            out.extend_from_slice(&self.source[cursor..*start]);
            out.extend_from_slice(content);
            cursor = *end;
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
}
