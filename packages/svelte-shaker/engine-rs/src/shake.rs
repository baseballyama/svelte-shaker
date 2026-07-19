//! Edit application over `MagicEdit` (transform.ts): fold if-chains and ternaries,
//! substitute folded-prop references, drop `$props()` entries and call-site
//! attributes.  Shares `decide_chain` with the analysis so folds never disagree.

use serde_json::Value;
use std::collections::{HashMap, HashSet};

use crate::ast::*;
use crate::css::shake_css;
use crate::dead_code::{decide_chain, is_full_removal, ChainDecision};
use crate::eval::{evaluate, Env, SetEnv};
use crate::plan::{remap_to_local_names, Model};
use crate::transform::MagicEdit;

pub(crate) const NL: u16 = b'\n' as u16;
pub(crate) const SEMI: u16 = b';' as u16;

pub(crate) fn is_ws_u16(u: u16) -> bool {
    u == b' ' as u16 || u == b'\t' as u16 || u == b'\n' as u16 || u == b'\r' as u16
}

/// `substitutedSlice`: the source for `[from,to)` with every folded-prop reference
/// inside `roots` replaced by its literal.
pub(crate) fn substituted_slice(edits: &MagicEdit, from: i64, to: i64, roots: &[&Value], env: &Env) -> String {
    if env.is_empty() {
        return edits.slice(from as usize, to as usize);
    }
    let mut refs: Vec<FoldRef> = Vec::new();
    {
        let mut emit = |r: FoldRef, _node: &Value| refs.push(r);
        for root in roots {
            collect_fold_refs(root, env, edits, &mut emit);
        }
    }
    if refs.is_empty() {
        return edits.slice(from as usize, to as usize);
    }
    refs.sort_by_key(|r| r.start);
    let mut out = String::new();
    let mut cursor = from;
    for r in refs {
        out.push_str(&edits.slice(cursor as usize, r.start as usize));
        out.push_str(&r.head);
        out.push_str(&env[&r.name].to_source());
        out.push_str(&r.tail);
        cursor = r.end;
    }
    out.push_str(&edits.slice(cursor as usize, to as usize));
    out
}

pub(crate) fn fragment_source(edits: &MagicEdit, fragment: &Value, env: &Env) -> String {
    match fragment.get("nodes").and_then(Value::as_array) {
        Some(n) if !n.is_empty() => {
            let from = off(&n[0], "start");
            let to = off(&n[n.len() - 1], "end");
            let roots: Vec<&Value> = n.iter().collect();
            substituted_slice(edits, from, to, &roots, env)
        }
        _ => String::new(),
    }
}

/// A text node whose source is entirely whitespace.
pub(crate) fn is_whitespace_text(node: &Value, edits: &MagicEdit) -> bool {
    type_of(node) == Some("Text")
        && edits.slice(off(node, "start") as usize, off(node, "end") as usize).trim().is_empty()
}

/// A sibling that adjacent whitespace can "lean on" so it renders a space.  A
/// whitespace-only text node is the seam whitespace itself, and a `Comment` is
/// transparent to SSR (acts as a fragment edge) — neither is a rendering neighbour.
pub(crate) fn is_rendering_sibling(node: &Value, edits: &MagicEdit) -> bool {
    type_of(node) != Some("Comment") && !is_whitespace_text(node, edits)
}

/// An element inside which Svelte preserves whitespace verbatim.
pub(crate) fn is_preserve_element(node: &Value) -> bool {
    type_of(node) == Some("RegularElement")
        && matches!(node.get("name").and_then(Value::as_str), Some("pre") | Some("textarea"))
}

/// Node types that reset the content-model parent to "unknown" (text allowed
/// again), mirroring svelte's `parent_element: null` reset in the SvelteElement /
/// SvelteFragment / SnippetBlock / Component visitors.  See transform.ts
/// `PARENT_ELEMENT_RESET`.
pub(crate) fn is_parent_element_reset(node: &Value) -> bool {
    matches!(
        type_of(node),
        Some("SvelteElement") | Some("SvelteFragment") | Some("SnippetBlock") | Some("Component") | Some("SvelteSelf") | Some("SvelteComponent")
    )
}

/// The content-model parent element a seam would land in for `node`'s children,
/// given the element the walk is currently inside.  Mirrors svelte's
/// `parent_element` threading: a `RegularElement` becomes the parent, the reset
/// node types clear it, every other node (Fragment, blocks, …) inherits.  `None`
/// means "text allowed" (root or a reset context).  See transform.ts
/// `childParentElement`.
pub(crate) fn child_parent_element<'a>(node: &'a Value, current: Option<&'a str>) -> Option<&'a str> {
    if type_of(node) == Some("RegularElement") {
        return node.get("name").and_then(Value::as_str);
    }
    if is_parent_element_reset(node) {
        return None;
    }
    current
}

/// True when an `{" "}` seam would be an invalid text child of `element`: these are
/// svelte's `disallowed_children` entries carrying an `only` list (text is in none
/// of them), restricted to the parts that can appear as elements inside a
/// component.  See transform.ts `TEXT_FREE_PARENTS` / `isTextFreeParent`.
pub(crate) fn is_text_free_parent(element: Option<&str>) -> bool {
    matches!(element, Some("table" | "thead" | "tbody" | "tfoot" | "tr" | "colgroup"))
}

/// True when an attribute value is the literal `{false}` (or `false`).
pub(crate) fn attr_is_explicit_false(value: &Value) -> bool {
    if value == &Value::Bool(false) {
        return true;
    }
    let parts: Vec<&Value> = match value {
        Value::Array(a) => a.iter().collect(),
        _ => vec![value],
    };
    parts.iter().any(|p| {
        type_of(p) == Some("ExpressionTag")
            && type_of(get(p, "expression")) == Some("Literal")
            && get(p, "expression").get("value") == Some(&Value::Bool(false))
    })
}

/// Does the component opt into preserved whitespace via `<svelte:options>`?
pub(crate) fn has_preserve_whitespace_option(fragment: &Value) -> bool {
    let mut preserve = false;
    walk(fragment, &mut |node| {
        if type_of(node) == Some("SvelteOptions") {
            for a in arr(node, "attributes") {
                if str_eq(a, "type", "Attribute")
                    && a.get("name").and_then(Value::as_str) == Some("preserveWhitespace")
                {
                    preserve = !attr_is_explicit_false(get(a, "value"));
                }
            }
        }
    });
    preserve
}

/// Decide whether removing the chain at `siblings[index]` loses a separating
/// space, returning the `[from, to]` span (covering the adjacent whitespace-only
/// siblings plus the chain) to overwrite with `{" "}` if so.  See transform.ts
/// `analyzeSeam` for the `origSpace`/`afterSpace` derivation.
pub(crate) fn analyze_seam(siblings: &[Value], index: usize, span: Span, edits: &MagicEdit, dead: &[Span]) -> Option<Span> {
    let live = |node: &Value| !in_spans(node, dead);
    let left = if index >= 1 { siblings.get(index - 1) } else { None };
    let l = left.filter(|n| live(n) && is_whitespace_text(n, edits));
    let r = siblings.get(index + 1).filter(|n| live(n) && is_whitespace_text(n, edits));

    let p_idx = if l.is_some() { index as isize - 2 } else { index as isize - 1 };
    let n_idx = if r.is_some() { index + 2 } else { index + 1 };
    let p = p_idx >= 0 && siblings.get(p_idx as usize).is_some_and(|n| is_rendering_sibling(n, edits));
    let n = siblings.get(n_idx).is_some_and(|node| is_rendering_sibling(node, edits));

    let orig_space = (l.is_some() && p) || (r.is_some() && n);
    let after_space = p && n && (l.is_some() || r.is_some());
    if !orig_space || after_space {
        return None;
    }
    Some((l.map_or(span.0, |n| off(n, "start")), r.map_or(span.1, |n| off(n, "end"))))
}

/// Delete a chain that renders nothing, compensating the seam (see transform.ts
/// `removeChain`) so the rendered whitespace is unchanged.
pub(crate) fn remove_chain(
    removed: &[Span],
    span: Span,
    edits: &mut MagicEdit,
    dead: &mut Vec<Span>,
    siblings: Option<&[Value]>,
    index: usize,
    preserve: bool,
    element: Option<&str>,
) {
    // Never compensate under preserved whitespace (plain deletion is byte-exact)
    // nor inside a text-free parent (`<tr>`, `<tbody>`, …), where Svelte rejects the
    // `{" "}` text child and the whitespace rendered nothing to begin with.
    if !preserve && !is_text_free_parent(element) {
        if let Some(sibs) = siblings {
            if let Some(seam) = analyze_seam(sibs, index, span, edits, dead) {
                edits.overwrite(seam.0 as usize, seam.1 as usize, "{\" \"}");
                dead.push(seam);
                return;
            }
        }
    }
    for (a, b) in removed {
        edits.remove(*a as usize, *b as usize);
        dead.push((*a, *b));
    }
}

pub(crate) fn apply_chain(
    decision: &ChainDecision,
    env: &Env,
    edits: &mut MagicEdit,
    dead: &mut Vec<Span>,
    siblings: Option<&[Value]>,
    index: usize,
    preserve: bool,
    element: Option<&str>,
) {
    if let Some(frag) = &decision.kept {
        let mut text = fragment_source(edits, frag, env);
        // Strip the kept arm's leading/trailing whitespace (block-fragment edges,
        // trimmed in the original) so splicing it inline does not gain a space.
        if !preserve {
            text = text.trim().to_string();
        }
        // A kept arm that renders nothing behaves like a full removal.
        if text.is_empty() && !preserve {
            remove_chain(&[decision.span], decision.span, edits, dead, siblings, index, preserve, element);
            return;
        }
        edits.overwrite(decision.span.0 as usize, decision.span.1 as usize, &text);
        dead.push(decision.span);
        return;
    }
    if is_full_removal(decision) {
        remove_chain(&decision.removed, decision.span, edits, dead, siblings, index, preserve, element);
        return;
    }
    for (a, b) in &decision.removed {
        edits.remove(*a as usize, *b as usize);
        dead.push((*a, *b));
    }
    if let Some((from, to, text)) = &decision.header_rewrite {
        edits.overwrite(*from as usize, *to as usize, text);
    }
}

pub(crate) fn fold_if_blocks<'a>(
    node: &'a Value,
    env: &Env,
    set_env: &SetEnv,
    edits: &mut MagicEdit,
    dead: &mut Vec<Span>,
    siblings: Option<&'a [Value]>,
    index: usize,
    preserve: bool,
    element: Option<&'a str>,
) {
    match node {
        Value::Array(items) => {
            for (i, v) in items.iter().enumerate() {
                fold_if_blocks(v, env, set_env, edits, dead, Some(items), i, preserve, element);
            }
        }
        Value::Object(map) => {
            if type_of(node) == Some("IfBlock") {
                if node.get("elseif") == Some(&Value::Bool(true)) || in_spans(node, dead) {
                    return;
                }
                let decision = decide_chain(node, env, set_env);
                apply_chain(&decision, env, edits, dead, siblings, index, preserve, element);
                if decision.recurse {
                    // kept head: the `{#if}` is transparent to the content model, so its
                    // children stay in the same parent element.
                    for v in map.values() {
                        fold_if_blocks(v, env, set_env, edits, dead, None, 0, preserve, element);
                    }
                }
                return;
            }
            let child_preserve = preserve || is_preserve_element(node);
            let child_element = child_parent_element(node, element);
            for v in map.values() {
                fold_if_blocks(v, env, set_env, edits, dead, None, 0, child_preserve, child_element);
            }
        }
        _ => {}
    }
}

pub(crate) fn fold_ternaries(node: &Value, env: &Env, edits: &mut MagicEdit, dead: &mut Vec<Span>) {
    match node {
        Value::Array(items) => {
            for v in items {
                fold_ternaries(v, env, edits, dead);
            }
        }
        Value::Object(map) => {
            if type_of(node) == Some("ConditionalExpression") {
                if in_spans(node, dead) {
                    return;
                }
                match evaluate(get(node, "test"), env) {
                    None => {
                        for v in map.values() {
                            fold_ternaries(v, env, edits, dead);
                        }
                    }
                    Some(t) => {
                        let taken = if t.is_truthy() { get(node, "consequent") } else { get(node, "alternate") };
                        if taken.is_null() {
                            for v in map.values() {
                                fold_ternaries(v, env, edits, dead);
                            }
                            return;
                        }
                        let text = substituted_slice(edits, off(taken, "start"), off(taken, "end"), &[taken], env);
                        edits.overwrite(off(node, "start") as usize, off(node, "end") as usize, &text);
                        dead.push((off(node, "start"), off(node, "end")));
                    }
                }
                return;
            }
            for v in map.values() {
                fold_ternaries(v, env, edits, dead);
            }
        }
        _ => {}
    }
}

/// One folded-prop edit: overwrite `[start,end)` with `head + <literal> + tail`.
/// A plain read has empty head/tail and the identifier's own span; a SHORTHAND
/// position wraps the literal back into explicit `name={…}` form (see
/// `fold_ref_for` / `collect_fold_refs`).  Mirrors `FoldRef` in transform.ts.
pub(crate) struct FoldRef {
    pub(crate) start: i64,
    pub(crate) end: i64,
    pub(crate) head: String,
    pub(crate) tail: String,
    pub(crate) name: String,
}

/// `collectFoldRefs`: visit every folded-prop reference in `root` — plain reads,
/// the `class:`/`{…}` shorthands `fold_ref_for` expands, and `style:NAME`
/// shorthands (no expression node) — calling `emit` with each edit and its node
/// (so callers can filter on position).  Shared by the live pass and
/// `substituted_slice` so both fold shorthands identically.
pub(crate) fn collect_fold_refs<F: FnMut(FoldRef, &Value)>(root: &Value, env: &Env, edits: &MagicEdit, emit: &mut F) {
    walk_grandparented(root, None, None, &mut |node, parent, grandparent| {
        // `style:NAME` shorthand carries no expression node (its `value` is the
        // boolean `true` marker); expand it to `style:NAME={lit}` or the dropped
        // prop dangles.  Trim trailing whitespace some parsers fold into `end`.
        if str_eq(node, "type", "StyleDirective") && node.get("value") == Some(&Value::Bool(true)) {
            if let Some(name) = node.get("name").and_then(Value::as_str) {
                if env.contains_key(name) {
                    let start = off(node, "start");
                    let mut end = off(node, "end");
                    while end > start && edits.unit_at((end - 1) as usize).map(is_ws_u16) == Some(true) {
                        end -= 1;
                    }
                    let src = edits.slice(start as usize, end as usize); // `style:NAME`
                    emit(
                        FoldRef { start, end, head: format!("{src}={{"), tail: "}".to_string(), name: name.to_string() },
                        node,
                    );
                }
            }
        } else if str_eq(node, "type", "Identifier") {
            if let Some(name) = node.get("name").and_then(Value::as_str) {
                if env.contains_key(name) && !is_non_reference(node, parent) {
                    emit(fold_ref_for(node, parent, grandparent, edits, name), node);
                }
            }
        }
    });
}

/// `foldRefFor`: the edit to substitute a folded prop at `node`.  A plain read
/// overwrites just the identifier; a SHORTHAND position expands to the explicit
/// `name={value}` form (`class:compact` -> `class:compact={false}`, `{compact}`
/// -> `compact={false}`) so the rewrite stays valid Svelte.
pub(crate) fn fold_ref_for(node: &Value, parent: Option<&Value>, grandparent: Option<&Value>, edits: &MagicEdit, name: &str) -> FoldRef {
    let start = off(node, "start");
    let end = off(node, "end");
    // `class:NAME` shorthand: the identifier sits in the directive-name slot, right
    // after the `:` (the long form puts it inside `={…}`, where the char is `{`).
    if let Some(p) = parent {
        if str_eq(p, "type", "ClassDirective")
            && same_node(get(p, "expression"), node)
            && start > 0
            && edits.unit_at((start - 1) as usize) == Some(b':' as u16)
        {
            return FoldRef { start, end, head: format!("{name}={{"), tail: "}".to_string(), name: name.to_string() };
        }
    }
    // `{NAME}` attribute shorthand: the braces belong to the Attribute, not the
    // ExpressionTag, so overwrite the whole attribute (`{NAME}` -> `NAME={lit}`).
    if let (Some(p), Some(gp)) = (parent, grandparent) {
        if str_eq(p, "type", "ExpressionTag")
            && str_eq(gp, "type", "Attribute")
            && edits.unit_at(off(gp, "start") as usize) == Some(b'{' as u16)
        {
            if let Some(attr_name) = gp.get("name").and_then(Value::as_str) {
                return FoldRef {
                    start: off(gp, "start"),
                    end: off(gp, "end"),
                    head: format!("{attr_name}={{"),
                    tail: "}".to_string(),
                    name: name.to_string(),
                };
            }
        }
    }
    // Object shorthand `{ NAME }`: a `Property` with `shorthand: true` whose single
    // identifier is BOTH key and value.  Expand to `NAME: lit` (a plain replace would
    // yield `{ "lit" }`, invalid).
    if let Some(p) = parent {
        if str_eq(p, "type", "Property")
            && p.get("shorthand") == Some(&Value::Bool(true))
            && same_node(get(p, "value"), node)
        {
            return FoldRef {
                start,
                end,
                head: format!("{name}: "),
                tail: String::new(),
                name: name.to_string(),
            };
        }
    }
    FoldRef { start, end, head: String::new(), tail: String::new(), name: name.to_string() }
}

pub(crate) fn collect_prop_refs(model: &Model, env: &Env, dead: &[Span], edits: &MagicEdit) -> Vec<FoldRef> {
    let mut refs = Vec::new();
    {
        let mut emit = |r: FoldRef, node: &Value| {
            if !in_spans(node, dead) {
                refs.push(r);
            }
        };
        collect_fold_refs(get(&model.ast, "instance"), env, edits, &mut emit);
        collect_fold_refs(get(&model.ast, "fragment"), env, edits, &mut emit);
    }
    refs
}

/// Delete the run of dropped destructuring properties `properties[lo..=hi]` together,
/// absorbing the commas/whitespace so the result stays valid: eat forward to the next
/// survivor when one follows; otherwise the run reaches the end, so include a trailing
/// comma (but not the whitespace before `}`) and reach back to the previous survivor.
pub(crate) fn remove_property_run(properties: &[Value], lo: usize, hi: usize, edits: &mut MagicEdit) {
    let first = &properties[lo];
    let last = &properties[hi];
    if let Some(kept_after) = properties.get(hi + 1) {
        edits.remove(off(first, "start") as usize, off(kept_after, "start") as usize);
        return;
    }
    let mut end = off(last, "end") as usize;
    let len = edits.len();
    let mut j = end;
    while j < len && edits.unit_at(j).map(is_ws_u16) == Some(true) {
        j += 1;
    }
    if edits.unit_at(j) == Some(b',' as u16) {
        end = j + 1;
    }
    let start = if lo > 0 {
        off(&properties[lo - 1], "end") as usize
    } else {
        off(first, "start") as usize
    };
    edits.remove(start, end);
}

pub(crate) fn remove_type_member(pattern: &Value, name: &str, edits: &mut MagicEdit) {
    let members = get(get(get(pattern, "typeAnnotation"), "typeAnnotation"), "members");
    let members = match members.as_array() {
        Some(m) => m,
        None => return,
    };
    let i = members.iter().position(|m| {
        str_eq(get(m, "key"), "type", "Identifier") && get(m, "key").get("name").and_then(Value::as_str) == Some(name)
    });
    let i = match i {
        Some(i) => i,
        None => return,
    };
    if let Some(next) = members.get(i + 1) {
        edits.remove(off(&members[i], "start") as usize, off(next, "start") as usize);
    } else if i > 0 {
        edits.remove(off(&members[i - 1], "end") as usize, off(&members[i], "end") as usize);
    } else {
        edits.remove(off(&members[i], "start") as usize, off(&members[i], "end") as usize);
    }
}

pub(crate) fn remove_whole_line(node: &Value, edits: &mut MagicEdit) {
    let start = off(node, "start") as usize;
    let end = off(node, "end") as usize;
    let len = edits.len();
    let mut line_start = start;
    while line_start > 0 && edits.unit_at(line_start - 1) != Some(NL) {
        line_start -= 1;
    }
    let mut line_end = end;
    while line_end < len && edits.unit_at(line_end) != Some(NL) {
        line_end += 1;
    }
    let prefix = edits.slice(line_start, start);
    let suffix = edits.slice(end, line_end);
    let suffix_non_ws: String = suffix.chars().filter(|c| !c.is_whitespace()).collect();
    if prefix.trim().is_empty() && (suffix_non_ws.is_empty() || suffix_non_ws == ";") {
        let rm_end = if line_end < len { line_end + 1 } else { line_end };
        edits.remove(line_start, rm_end);
    } else {
        let rm_end = if edits.unit_at(end) == Some(SEMI) { end + 1 } else { end };
        edits.remove(start, rm_end);
    }
}

pub(crate) fn drop_props(model: &Model, drop: &HashSet<String>, edits: &mut MagicEdit) {
    let pi = match &model.props_info {
        Some(p) => p,
        None => return,
    };
    if drop.is_empty() {
        return;
    }
    let remaining = pi.props.iter().filter(|p| !drop.contains(&p.name)).count();
    if remaining == 0 && !pi.has_rest {
        remove_whole_line(&pi.declaration, edits);
        return;
    }
    let properties = arr(&pi.pattern, "properties");
    // Remove each maximal RUN of consecutive dropped properties as one range so the
    // separating commas tile cleanly (a per-property removal mishandles a trailing
    // comma on the last property and overlaps on consecutive drops -> dangling `,`).
    let dropped_flags: Vec<bool> = properties
        .iter()
        .map(|p| pi.props.iter().any(|d| same_node(&d.property, p) && drop.contains(&d.name)))
        .collect();
    let mut i = 0;
    while i < properties.len() {
        if !dropped_flags[i] {
            i += 1;
            continue;
        }
        let mut hi = i;
        while hi + 1 < properties.len() && dropped_flags[hi + 1] {
            hi += 1;
        }
        remove_property_run(properties, i, hi, edits);
        i = hi + 1;
    }
    for decl in &pi.props {
        if drop.contains(&decl.name) {
            remove_type_member(&pi.pattern, &decl.name, edits);
        }
    }
}

/// A call-site attribute is safe to delete only if its value has no side effects:
/// boolean shorthand / plain text / a literal expression, OR a forwarded
/// expression the OWNER's fold env proves constant (`prop={ownerConst}`) — which
/// phase 1 already substituted to a literal, so deleting it is exactly as sound as
/// for a literal (interprocedural pass-through cleanup, docs §13.1). Mirrors
/// `isSideEffectFree` in transform.ts.
pub(crate) fn is_side_effect_free(value: &Value, owner_env: &Env) -> bool {
    if value == &Value::Bool(true) || value.is_null() {
        return true;
    }
    let single;
    let parts: &[Value] = match value.as_array() {
        Some(a) => a,
        None => {
            single = [value.clone()];
            &single
        }
    };
    parts.iter().all(|part| match type_of(part) {
        Some("Text") => true,
        Some("ExpressionTag") => {
            let expr = get(part, "expression");
            str_eq(expr, "type", "Literal") || evaluate(expr, owner_env).is_some()
        }
        _ => false,
    })
}

pub(crate) fn remove_attr_with_space(attr: &Value, edits: &mut MagicEdit) {
    let mut start = off(attr, "start") as usize;
    if start > 0 && matches!(edits.unit_at(start - 1), Some(c) if c == b' ' as u16 || c == b'\t' as u16) {
        start -= 1;
    }
    edits.remove(start, off(attr, "end") as usize);
}

pub(crate) fn remove_call_site_attributes(
    model: &Model,
    dropped: &HashMap<String, HashSet<String>>,
    edits: &mut MagicEdit,
    edited_spans: &[Span],
    owner_env: &Env,
) {
    // Collect first (so we don't borrow the ast through `walk` while editing).
    let mut to_remove: Vec<Value> = Vec::new();
    walk(get(&model.ast, "fragment"), &mut |node| {
        if !str_eq(node, "type", "Component") {
            return;
        }
        // Skip a `<Child/>` phase 1 folded away: its source (attributes included) is
        // gone, so editing it now would overlap that edit.
        if !edited_spans.is_empty() && in_spans(node, edited_spans) {
            return;
        }
        let drop = node
            .get("name")
            .and_then(Value::as_str)
            .and_then(|n| model.imports.get(n))
            .and_then(|cid| dropped.get(cid));
        if let Some(drop) = drop {
            if drop.is_empty() {
                return;
            }
            for attr in arr(node, "attributes") {
                if type_of(attr) == Some("Attribute") {
                    if let Some(name) = attr.get("name").and_then(Value::as_str) {
                        if drop.contains(name) && is_side_effect_free(get(attr, "value"), owner_env) {
                            to_remove.push(attr.clone());
                        }
                    }
                }
            }
        }
    });
    for attr in &to_remove {
        remove_attr_with_space(attr, edits);
    }
}

/// Slim one component into `edits`, returning the props dropped from the
/// `$props()` signature (mirrors `shakeBody`).
pub(crate) fn shake_body(
    model: &Model,
    env: &Env,
    set_env: &SetEnv,
    edits: &mut MagicEdit,
    out_dead: &mut Vec<Span>,
    // Reverse-removal regions (docs §PR4) to treat as already-dead: the fold and
    // substitution passes skip anything inside them, so no edit lands in a span
    // the reverse phase then deletes whole.  Empty for the mono path.
    seed_dead: &[Span],
    // EXTERNAL prop names to also drop from the `$props()` signature — the unread
    // declared props (docs §PR7).  Folded into the SAME `drop_props` call as the
    // const-fold drops so consecutive dropped properties tile cleanly, but NOT
    // returned: an unread prop's call-site attributes are removed by the
    // reverse/unread phase (spread-aware), not phase 2.  Empty for the mono path.
    extra_drops: &HashSet<String>,
) -> HashSet<String> {
    if env.is_empty() && set_env.is_empty() {
        // …but an unread-prop drop (docs §PR7) still edits the signature.
        if !extra_drops.is_empty() {
            drop_props(model, extra_drops, edits);
        }
        return HashSet::new();
    }
    let fragment = get(&model.ast, "fragment");
    // `env`/`set_env` arrive keyed by the EXTERNAL prop name (that is what the plan
    // carries).  Every body/template reference, however, uses the prop's LOCAL
    // binding name (`prop: alias` -> `alias`), and the two can even be different
    // entities (a same-named import).  Remap ONCE to local-keyed envs for every
    // name-matched pass below (branch folding, ternaries, reference substitution,
    // CSS); the `$props()` signature drop keeps the external names.
    let local_env = remap_to_local_names(env, model);
    let local_set_env = remap_to_local_names(set_env, model);
    // Pre-load the reverse-removal regions so every pass below treats them as
    // already-dead and never edits inside a span the reverse phase then removes.
    let mut dead: Vec<Span> = seed_dead.to_vec();
    fold_if_blocks(fragment, &local_env, &local_set_env, edits, &mut dead, None, 0, has_preserve_whitespace_option(fragment), None);
    if !local_env.is_empty() {
        fold_ternaries(fragment, &local_env, edits, &mut dead);
    }
    for r in collect_prop_refs(model, &local_env, &dead, edits) {
        let text = format!("{}{}{}", r.head, local_env[&r.name].to_source(), r.tail);
        edits.overwrite(r.start as usize, r.end as usize, &text);
    }
    // The drop matches the destructure KEYS, so it keeps the EXTERNAL names (which
    // is also what phase 2's call-site attribute removal consumes).  Fold the
    // unread declared props (docs §PR7) into the SAME `drop_props` call so
    // consecutive dropped properties tile cleanly, but return only the folded set.
    let droppable: HashSet<String> = env.keys().cloned().collect();
    if extra_drops.is_empty() {
        drop_props(model, &droppable, edits);
    } else {
        drop_props(model, &droppable.union(extra_drops).cloned().collect(), edits);
    }
    shake_css(model, &local_env, &local_set_env, edits);
    // Hand phase 2 the regions we edited so it never edits inside a folded-away branch.
    out_dead.extend(dead.iter().copied());
    droppable
}
