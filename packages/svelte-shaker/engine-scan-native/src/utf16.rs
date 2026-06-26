//! UTF-8 byte offset -> UTF-16 code-unit offset remap for the serialized AST.
//!
//! rsvelte parses in UTF-8 byte offsets, but svelte/compiler — and therefore the
//! svelte-shaker engine and every ESLint consumer downstream — expects UTF-16
//! code-unit offsets (rsvelte #793). rsvelte's own `Utf8ToUtf16` /
//! `convert_positions_to_utf16` are `pub(crate)`, so we reimplement the exact
//! same remap here (a faithful port of `compiler/legacy.rs`) rather than depend
//! on a private API. Only non-ASCII sources need this; ASCII sources already
//! coincide in both encodings and skip it for free.

use serde_json::{json, Value};

/// Converter from UTF-8 byte positions to UTF-16 code-unit positions. Faithful
/// port of rsvelte_core's `compiler::legacy::Utf8ToUtf16` so produced offsets
/// match `napi::parse` (and thus svelte/compiler) byte-for-byte.
pub struct Utf8ToUtf16 {
    utf16_pos: Vec<usize>,
    /// Byte offset of each line start (parallel to `line_starts_utf16`).
    line_starts_byte: Vec<usize>,
    /// UTF-16 offset of each line start.
    line_starts_utf16: Vec<usize>,
}

impl Utf8ToUtf16 {
    pub fn new(source: &str) -> Self {
        let mut utf16_pos = Vec::with_capacity(source.len() + 1);
        let mut utf16_idx = 0;
        let mut line_starts_byte = vec![0];
        let mut line_starts_utf16 = vec![0];
        let mut byte_idx = 0;

        for c in source.chars() {
            let utf8_len = c.len_utf8();
            let utf16_len = c.len_utf16();
            for _ in 0..utf8_len {
                utf16_pos.push(utf16_idx);
            }
            utf16_idx += utf16_len;
            byte_idx += utf8_len;

            if c == '\n' {
                line_starts_byte.push(byte_idx);
                line_starts_utf16.push(utf16_idx);
            }
        }
        utf16_pos.push(utf16_idx);
        Self { utf16_pos, line_starts_byte, line_starts_utf16 }
    }

    pub fn convert(&self, utf8_pos: usize) -> usize {
        if utf8_pos >= self.utf16_pos.len() {
            *self.utf16_pos.last().unwrap_or(&0)
        } else {
            self.utf16_pos[utf8_pos]
        }
    }

    /// Convert a 0-based byte column on a 1-based line to a UTF-16 column.
    fn convert_column(&self, line: usize, byte_column: usize) -> usize {
        if line == 0 || line > self.line_starts_byte.len() {
            return byte_column;
        }
        let line_start_byte = self.line_starts_byte[line - 1];
        let line_start_utf16 = self.line_starts_utf16[line - 1];
        let abs_byte_pos = line_start_byte + byte_column;
        let abs_utf16_pos = self.convert(abs_byte_pos);
        abs_utf16_pos.saturating_sub(line_start_utf16)
    }
}

/// Recursively remap every `start` / `end` / `character` offset (and `loc`
/// `column`) in the serialized AST from UTF-8 bytes to UTF-16 code units, in
/// place. Mirror of rsvelte_core's `convert_positions_to_utf16`.
pub fn convert_positions_to_utf16(value: &mut Value, conv: &Utf8ToUtf16) {
    match value {
        Value::Object(map) => {
            for key in ["start", "end", "character"] {
                if let Some(Value::Number(n)) = map.get(key) {
                    if let Some(pos) = n.as_u64() {
                        map.insert(key.to_string(), json!(conv.convert(pos as usize)));
                    }
                }
            }
            if map.contains_key("line") && map.contains_key("column") {
                if let (Some(Value::Number(line)), Some(Value::Number(col))) =
                    (map.get("line"), map.get("column"))
                {
                    if let (Some(line_num), Some(col_num)) = (line.as_u64(), col.as_u64()) {
                        let new_col = conv.convert_column(line_num as usize, col_num as usize);
                        map.insert("column".to_string(), json!(new_col));
                    }
                }
            }
            for v in map.values_mut() {
                convert_positions_to_utf16(v, conv);
            }
        }
        Value::Array(arr) => {
            for item in arr {
                convert_positions_to_utf16(item, conv);
            }
        }
        _ => {}
    }
}
