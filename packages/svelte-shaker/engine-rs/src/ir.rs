//! The engine's internal template IR (docs/RUST-MIGRATION.md M4; docs/ARCHITECTURE.md §6.4).
//!
//! A typed, owned view of the template STRUCTURE, built by [`from_value`] from the
//! svelte/compiler-shaped JSON `Value` the engine consumes. BOTH engines build it the
//! same way — there is no direct `rsvelte Root → IR` converter: the wasm path gets the
//! `Value` from the JS-side parse, and the native path serializes rsvelte's `Root` to
//! the SAME `Value` form (`engine-scan-native/src/session.rs` `root_to_ast_value`) and
//! then calls `from_value`. (The M4 plan to add a rsvelte→IR frontend and move the
//! whole engine onto the IR was not pursued; only the template-structure walks below
//! use it.) It replaces the per-fixpoint-round re-walking of the `Value` template in
//! the dead-branch scan (`compute_dead_spans_ir`) and `build_model`'s binder / escape
//! reads with a fast typed walk; the rest of the engine (shake_body, css, eval) still
//! reads the `Value`.
//!
//! Scope (deliberately bounded — see the M4 inventory): the IR types the TEMPLATE
//! structure — the part that is large and re-walked every fixpoint round. The two
//! things the engine reads that are NOT template structure stay as `serde_json::Value`
//! sub-trees, unchanged:
//!  - JS EXPRESSIONS (a `{#if}` test, an attribute `{expr}`, the instance `<script>`)
//!    — rsvelte exposes them only via `as_json()`, and the engine's `eval.rs` /
//!    import / prop analysis already reads that ESTree JSON. Keeping them Value leaves
//!    `eval.rs` untouched and its existing pins intact. These Values are small.
//!  - CSS (`<style>`) — `css.rs` reads it as Value; small (one block per file).
//!
//! Every node carries its source `span`, byte-for-byte the offsets the transform
//! edits against (UTF-16 units, matching svelte/compiler and rsvelte's remapped
//! output — already pinned by the scan_via_value AST oracle).
//!
//! ## Fallback discipline ([`Node::OtherTag`], [`Attribute::Other`])
//!
//! A catch-all forfeits some of the "a missed node kind is a compile error" benefit
//! of typing, so it is fenced by three rules — the sole correctness criterion being
//! byte-parity with the TS engine:
//!  1. **Reproduce the engine's generic-walk behavior exactly.** The engine's `walk`
//!     visits every node, reads no type-specific info for an un-handled tag/directive,
//!     but DOES recurse into its expression. So a fallback node contributes nothing to
//!     typed analysis and is otherwise handled only through its expression.
//!  2. **INVARIANT: fallback Values are never dropped from the escape/reads pass.** The
//!     walk decomposition (typed-template walk + Value delegation for embedded JS) MUST
//!     feed every `OtherTag`/`Other` node's Value — and every typed node's embedded
//!     expression Value — to the escape/reads Value-walk. A future editor must not
//!     assume "the typed walk alone is exhaustive": the JS reads live in the delegated
//!     Values.
//!  3. **Fallback is for KNOWN-but-unhandled kinds only.** The converters enumerate the
//!     known `type` strings; a truly unknown one (e.g. a new node kind from a
//!     svelte/rsvelte bump) hits a `debug_assert!`, never a silent passthrough. Only
//!     tags/directives (never fragment-bearing nodes) may fall back, so no `<Component>`
//!     call site can hide from the typed `child_calls` walk.

use serde_json::Value;

/// A source span in UTF-16 code units — the unit `MagicEdit` indexes by.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Span {
    pub start: u32,
    pub end: u32,
}

/// A template fragment: an ordered list of nodes (`fragment.nodes`).
#[derive(Clone, Debug, Default)]
pub struct Fragment {
    pub nodes: Vec<Node>,
}

/// One template node. Variants mirror svelte/compiler's template node `type`s (and
/// rsvelte's `TemplateNode`), so both converters map 1:1. Embedded JS expressions
/// are kept as `Value` (see the module docs).
#[derive(Clone, Debug)]
pub enum Node {
    Text(Text),
    Comment(Span),

    /// `<Local …/>` or `<ns.X …/>` — a rendered component. `name` is the tag.
    Component(Element),
    /// A plain HTML element (`<div …>`).
    RegularElement(Element),
    /// `<title>`, `<slot>`, and the `<svelte:*>` element-like tags. `name` is the tag
    /// (e.g. `"svelte:head"`); they share the element shape (name + attrs + fragment).
    SpecialElement(Element),
    /// `<svelte:options …>` — carried apart because it drives a whole-component bail
    /// (`accessors` / `customElement`).
    SvelteOptions(Element),
    /// `<svelte:component this={expr}>` — `expr` is the dynamic component expression.
    SvelteComponent(DynamicElement),
    /// `<svelte:element this={expr}>` — `expr` is the dynamic tag expression.
    SvelteElement(DynamicElement),

    /// `{expr}` in the template.
    ExpressionTag(Expr),
    /// `{@html expr}`.
    HtmlTag(Expr),
    /// `{@const …}` — `expr` holds the declaration.
    ConstTag(Expr),
    /// `{@debug a, b}` — the debugged identifier expressions.
    DebugTag(Vec<Value>),
    /// `{@render expr(…)}`.
    RenderTag(Expr),
    /// `{@attach expr}` (as a standalone tag).
    AttachTag(Expr),
    /// Fallback for a KNOWN template tag that the engine does NOT process
    /// type-specifically — it only walks the tag's JS expression (for escape / read
    /// detection). Discipline (see module docs "Fallback discipline"):
    ///  - PARITY: the engine's generic `walk` visits such a node, extracts no
    ///    type-specific info, but recurses INTO its expression. This variant must
    ///    reproduce exactly that: contribute nothing to typed analysis, and its
    ///    `node` Value MUST be fed to the escape/reads Value-walk (invariant below).
    ///  - Only tags land here. Every FRAGMENT-bearing node (anything that can contain
    ///    a `<Component>`) is an explicit variant, so no call site can hide in a
    ///    fallback and be missed by the typed `child_calls` walk.
    ///  - The converter maps only KNOWN-but-unhandled `type`s here and `debug_assert!`s
    ///    on a truly unknown `type` string, so a new svelte/rsvelte node kind is caught,
    ///    not silently swallowed.
    OtherTag(OtherTag),

    IfBlock(Box<IfBlock>),
    EachBlock(Box<EachBlock>),
    AwaitBlock(Box<AwaitBlock>),
    KeyBlock(Box<KeyBlock>),
    SnippetBlock(Box<SnippetBlock>),
}

#[derive(Clone, Debug)]
pub struct Text {
    pub span: Span,
    /// The literal text (`data`), needed to tell whitespace-only nodes apart.
    pub data: String,
}

/// An element-like node: a tag name, attributes, and child fragment. Covers
/// `Component` / `RegularElement` / the special elements / `<svelte:options>`.
#[derive(Clone, Debug)]
pub struct Element {
    pub span: Span,
    pub name: String,
    pub attributes: Vec<Attribute>,
    pub fragment: Fragment,
}

/// `<svelte:component>` / `<svelte:element>`: like an element but with a leading
/// dynamic expression (`this={expr}` / the tag expression).
#[derive(Clone, Debug)]
pub struct DynamicElement {
    pub span: Span,
    pub expr: Value,
    pub attributes: Vec<Attribute>,
    pub fragment: Fragment,
}

/// A tag carrying a single JS expression, kept as Value (`{expr}`, `{@html expr}`, …).
#[derive(Clone, Debug)]
pub struct Expr {
    pub span: Span,
    pub expr: Value,
}

/// A JS-carrying tag the engine handles only by generic walk: the raw node Value.
#[derive(Clone, Debug)]
pub struct OtherTag {
    pub span: Span,
    pub node: Value,
}

/// `{#if test}…{:else if}…{:else}…{/if}`. `elseif` marks a node that is itself the
/// single child of a parent if's `alternate` (an `{:else if}` link), which the
/// transform treats transparently.
#[derive(Clone, Debug)]
pub struct IfBlock {
    pub span: Span,
    pub elseif: bool,
    pub test: Value,
    pub consequent: Fragment,
    pub alternate: Option<Fragment>,
    /// The raw `{#if}` node Value — LOAD-BEARING, not a migration leftover. The typed
    /// walk FINDs if-blocks fast (the per-round hot path), but the dead-branch DECISION
    /// (`decide_chain`) stays on Value: it evaluates the embedded-JS `{#if}` test,
    /// collects the `{:else if}` chain, reads arm spans, and returns the KEPT fragment
    /// Value that `shake_body`'s `fold_if_blocks` re-emits. That is by design — the
    /// hybrid IR types only the template STRUCTURE and keeps embedded JS as Value — so
    /// `decide_chain` needs the node's Value form here.
    pub raw: Value,
}

/// `{#each expression as context, index (key)}…{:else}…{/each}`.
#[derive(Clone, Debug)]
pub struct EachBlock {
    pub span: Span,
    pub expression: Value,
    pub context: Option<Value>,
    pub index: Option<String>,
    pub key: Option<Value>,
    pub body: Fragment,
    pub fallback: Option<Fragment>,
}

/// `{#await expression}…{:then value}…{:catch error}…{/await}`.
#[derive(Clone, Debug)]
pub struct AwaitBlock {
    pub span: Span,
    pub expression: Value,
    pub value: Option<Value>,
    pub error: Option<Value>,
    pub pending: Option<Fragment>,
    pub then: Option<Fragment>,
    pub catch: Option<Fragment>,
}

/// `{#key expression}…{/key}`.
#[derive(Clone, Debug)]
pub struct KeyBlock {
    pub span: Span,
    pub expression: Value,
    pub fragment: Fragment,
}

/// `{#snippet name(params)}…{/snippet}`.
#[derive(Clone, Debug)]
pub struct SnippetBlock {
    pub span: Span,
    /// The snippet name expression (an Identifier), kept as Value.
    pub expression: Value,
    pub parameters: Vec<Value>,
    pub body: Fragment,
}

/// An attribute or directive on an element/component.
#[derive(Clone, Debug)]
pub enum Attribute {
    /// `name="…"` / `name={expr}` / `name`. `value` is the raw attribute `value`
    /// (Value: `true`, an ExpressionTag, or a sequence of Text/ExpressionTag), read
    /// by the css / fold analysis unchanged.
    Attribute(NamedAttr),
    /// `{...expr}`.
    Spread(Expr),
    /// `bind:name={expr}`.
    Bind(NamedAttr),
    /// `class:name={expr}`.
    Class(NamedAttr),
    /// `style:name={value}`.
    Style(NamedAttr),
    /// A KNOWN directive the engine does not process type-specifically — `on:` /
    /// `use:` / `transition:` / `animate:` / `let:` / `{@attach}`. Same discipline as
    /// [`Node::OtherTag`]: the engine only walks its expression for escapes, so this
    /// keeps the raw node Value and that Value MUST be fed to the escape/reads
    /// Value-walk (invariant below). The converter maps only these known directive
    /// `type`s here and `debug_assert!`s on an unknown attribute `type`.
    Other(OtherTag),
}

/// A named attribute/directive: its `name` plus its raw `value`/`expression` Value.
#[derive(Clone, Debug)]
pub struct NamedAttr {
    pub span: Span,
    pub name: String,
    /// The attribute `value` (for `Attribute`/`Style`) or `expression` (for
    /// `Bind`/`Class`), kept as Value for the css / fold / escape reads.
    pub value: Value,
}

/// The whole component: its template fragment plus the instance / module scripts and
/// `<style>`, all kept as Value (the engine's script/props/css analysis reads them
/// unchanged). This is what `build_model` consumes instead of the raw AST Value.
#[derive(Clone, Debug)]
pub struct Root {
    pub fragment: Fragment,
    /// The instance `<script>` node Value (`ast.instance`), or Null.
    pub instance: Value,
    /// The module `<script>` node Value (`ast.module`), or Null.
    pub module: Value,
    /// The whole component's raw AST Value (svelte/compiler JSON). Held because the
    /// engine's Value-based phases read it directly — `shake_body`'s fold/strip passes,
    /// `css.rs`, and the fold analysis all walk this `Value` (the IR types only the
    /// template structure, §module docs). Not a migration leftover.
    pub ast: Value,
}

// =============================================================================
// Value → IR converter — the wasm frontend (the input JSON is already parsed on
// the JS side) and, in slice (a), the source `build_model` reads through. Maps the
// svelte/compiler JSON shape faithfully (verified against the real parser output);
// the native `rsvelte Root → IR` converter (a later slice) produces the same IR.
// =============================================================================

fn ntype(node: &Value) -> &str {
    node.get("type").and_then(Value::as_str).unwrap_or("")
}
fn u32_at(node: &Value, key: &str) -> u32 {
    node.get(key).and_then(Value::as_u64).unwrap_or(0) as u32
}
fn span_of(node: &Value) -> Span {
    Span { start: u32_at(node, "start"), end: u32_at(node, "end") }
}
fn name_of(node: &Value) -> String {
    node.get("name").and_then(Value::as_str).unwrap_or("").to_string()
}
fn cloned(node: &Value, key: &str) -> Value {
    node.get(key).cloned().unwrap_or(Value::Null)
}
fn opt_val(node: &Value, key: &str) -> Option<Value> {
    node.get(key).filter(|v| !v.is_null()).cloned()
}

fn fragment_from(frag: Option<&Value>) -> Fragment {
    let nodes = frag
        .and_then(|f| f.get("nodes"))
        .and_then(Value::as_array)
        .map(|arr| arr.iter().map(node_from).collect())
        .unwrap_or_default();
    Fragment { nodes }
}
fn frag_field(node: &Value, key: &str) -> Fragment {
    fragment_from(node.get(key))
}
fn opt_frag(node: &Value, key: &str) -> Option<Fragment> {
    node.get(key).filter(|v| !v.is_null()).map(|f| fragment_from(Some(f)))
}

fn element_from(node: &Value) -> Element {
    Element { span: span_of(node), name: name_of(node), attributes: attrs_from(node), fragment: frag_field(node, "fragment") }
}
fn dynamic_from(node: &Value, expr_key: &str) -> DynamicElement {
    DynamicElement { span: span_of(node), expr: cloned(node, expr_key), attributes: attrs_from(node), fragment: frag_field(node, "fragment") }
}
fn expr_from(node: &Value, key: &str) -> Expr {
    Expr { span: span_of(node), expr: cloned(node, key) }
}

/// Convert a whole component AST (svelte/compiler JSON) into the IR.
pub fn from_value(ast: &Value) -> Root {
    Root {
        fragment: fragment_from(ast.get("fragment")),
        instance: ast.get("instance").cloned().unwrap_or(Value::Null),
        module: ast.get("module").cloned().unwrap_or(Value::Null),
        ast: ast.clone(),
    }
}

fn node_from(node: &Value) -> Node {
    match ntype(node) {
        "Text" => Node::Text(Text {
            span: span_of(node),
            data: node.get("data").and_then(Value::as_str).unwrap_or("").to_string(),
        }),
        "Comment" => Node::Comment(span_of(node)),
        "Component" => Node::Component(element_from(node)),
        "RegularElement" => Node::RegularElement(element_from(node)),
        "TitleElement" | "SlotElement" | "SvelteBody" | "SvelteDocument" | "SvelteFragment"
        | "SvelteBoundary" | "SvelteHead" | "SvelteSelf" | "SvelteWindow" => Node::SpecialElement(element_from(node)),
        "SvelteOptions" => Node::SvelteOptions(element_from(node)),
        "SvelteComponent" => Node::SvelteComponent(dynamic_from(node, "expression")),
        "SvelteElement" => Node::SvelteElement(dynamic_from(node, "tag")),
        "ExpressionTag" => Node::ExpressionTag(expr_from(node, "expression")),
        "HtmlTag" => Node::HtmlTag(expr_from(node, "expression")),
        "ConstTag" => Node::ConstTag(expr_from(node, "declaration")),
        "RenderTag" => Node::RenderTag(expr_from(node, "expression")),
        "AttachTag" => Node::AttachTag(expr_from(node, "expression")),
        "DebugTag" => Node::DebugTag(node.get("identifiers").and_then(Value::as_array).cloned().unwrap_or_default()),
        "IfBlock" => Node::IfBlock(Box::new(IfBlock {
            span: span_of(node),
            elseif: node.get("elseif") == Some(&Value::Bool(true)),
            test: cloned(node, "test"),
            consequent: frag_field(node, "consequent"),
            alternate: opt_frag(node, "alternate"),
            raw: node.clone(),
        })),
        "EachBlock" => Node::EachBlock(Box::new(EachBlock {
            span: span_of(node),
            expression: cloned(node, "expression"),
            context: opt_val(node, "context"),
            index: node.get("index").and_then(Value::as_str).map(str::to_string),
            key: opt_val(node, "key"),
            body: frag_field(node, "body"),
            fallback: opt_frag(node, "fallback"),
        })),
        "AwaitBlock" => Node::AwaitBlock(Box::new(AwaitBlock {
            span: span_of(node),
            expression: cloned(node, "expression"),
            value: opt_val(node, "value"),
            error: opt_val(node, "error"),
            pending: opt_frag(node, "pending"),
            then: opt_frag(node, "then"),
            catch: opt_frag(node, "catch"),
        })),
        "KeyBlock" => Node::KeyBlock(Box::new(KeyBlock {
            span: span_of(node),
            expression: cloned(node, "expression"),
            fragment: frag_field(node, "fragment"),
        })),
        "SnippetBlock" => Node::SnippetBlock(Box::new(SnippetBlock {
            span: span_of(node),
            expression: cloned(node, "expression"),
            parameters: node.get("parameters").and_then(Value::as_array).cloned().unwrap_or_default(),
            body: frag_field(node, "body"),
        })),
        // Known JS-carrying tag the engine only generic-walks; its expression is
        // reached through the Value-walk delegation (see the fallback invariant).
        "DeclarationTag" => Node::OtherTag(OtherTag { span: span_of(node), node: node.clone() }),
        other => {
            debug_assert!(false, "ir: unknown template node type {other:?}");
            Node::OtherTag(OtherTag { span: span_of(node), node: node.clone() })
        }
    }
}

fn attrs_from(node: &Value) -> Vec<Attribute> {
    node.get("attributes")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().map(attr_from).collect())
        .unwrap_or_default()
}
fn named_attr(node: &Value, value_key: &str) -> NamedAttr {
    NamedAttr { span: span_of(node), name: name_of(node), value: cloned(node, value_key) }
}
fn attr_from(attr: &Value) -> Attribute {
    match ntype(attr) {
        "Attribute" => Attribute::Attribute(named_attr(attr, "value")),
        "SpreadAttribute" => Attribute::Spread(expr_from(attr, "expression")),
        "BindDirective" => Attribute::Bind(named_attr(attr, "expression")),
        "ClassDirective" => Attribute::Class(named_attr(attr, "expression")),
        "StyleDirective" => Attribute::Style(named_attr(attr, "value")),
        "OnDirective" | "UseDirective" | "TransitionDirective" | "AnimateDirective" | "LetDirective"
        | "AttachTag" => Attribute::Other(OtherTag { span: span_of(attr), node: attr.clone() }),
        other => {
            debug_assert!(false, "ir: unknown attribute type {other:?}");
            Attribute::Other(OtherTag { span: span_of(attr), node: attr.clone() })
        }
    }
}

// =============================================================================
// The typed half of the walk decomposition: visit every template node, depth-first
// (a node, then its child fragments in source order). Callers that also need the
// embedded JS (escape / reads) delegate each node's expression Value to the Value
// walk — see the fallback invariant in the module docs.
// =============================================================================

/// Visit every node in `fragment` and its descendants.
pub fn walk<F: FnMut(&Node)>(fragment: &Fragment, f: &mut F) {
    for node in &fragment.nodes {
        visit(node, f);
    }
}

/// Exhaustive over `Node` so a new fragment-bearing variant is a compile error here,
/// never a silently-unvisited subtree (which could drop a `<Component>` call site).
fn visit<F: FnMut(&Node)>(node: &Node, f: &mut F) {
    f(node);
    match node {
        Node::Component(e)
        | Node::RegularElement(e)
        | Node::SpecialElement(e)
        | Node::SvelteOptions(e) => walk(&e.fragment, f),
        Node::SvelteComponent(d) | Node::SvelteElement(d) => walk(&d.fragment, f),
        Node::IfBlock(b) => {
            walk(&b.consequent, f);
            if let Some(alt) = &b.alternate {
                walk(alt, f);
            }
        }
        Node::EachBlock(b) => {
            walk(&b.body, f);
            if let Some(fb) = &b.fallback {
                walk(fb, f);
            }
        }
        Node::AwaitBlock(b) => {
            for fr in [&b.pending, &b.then, &b.catch].into_iter().flatten() {
                walk(fr, f);
            }
        }
        Node::KeyBlock(b) => walk(&b.fragment, f),
        Node::SnippetBlock(b) => walk(&b.body, f),
        // Leaves: no child fragment can hold a nested node.
        Node::Text(_)
        | Node::Comment(_)
        | Node::ExpressionTag(_)
        | Node::HtmlTag(_)
        | Node::ConstTag(_)
        | Node::DebugTag(_)
        | Node::RenderTag(_)
        | Node::AttachTag(_)
        | Node::OtherTag(_) => {}
    }
}

/// Every rendered `<Component>` in source order, as `(tag name, span)` — the IR-walk
/// equivalent of the engine's current `walk(fragment)` `Component` collection that
/// backs `child_calls`. Used by the slice-(a) parity pin against the Value walk.
pub fn component_tags(root: &Root) -> Vec<(String, Span)> {
    let mut out = Vec::new();
    walk(&root.fragment, &mut |node| {
        if let Node::Component(e) = node {
            out.push((e.name.clone(), e.span));
        }
    });
    out
}

impl Node {
    /// The node's attributes (element-like nodes carry them; others have none).
    pub fn attributes(&self) -> &[Attribute] {
        match self {
            Node::Component(e) | Node::RegularElement(e) | Node::SpecialElement(e) | Node::SvelteOptions(e) => &e.attributes,
            Node::SvelteComponent(d) | Node::SvelteElement(d) => &d.attributes,
            _ => &[],
        }
    }

    /// Every JS expression Value this node embeds DIRECTLY (not its attributes'
    /// expressions — [`Attribute::value`] — and not its child fragments). The
    /// reads/escape passes delegate these to the Value walk (the fallback invariant).
    pub fn embedded_exprs(&self) -> Vec<&Value> {
        match self {
            Node::ExpressionTag(e) | Node::HtmlTag(e) | Node::ConstTag(e) | Node::RenderTag(e)
            | Node::AttachTag(e) => vec![&e.expr],
            Node::DebugTag(ids) => ids.iter().collect(),
            Node::SvelteComponent(d) | Node::SvelteElement(d) => vec![&d.expr],
            Node::IfBlock(b) => vec![&b.test],
            Node::EachBlock(b) => {
                let mut v = vec![&b.expression];
                v.extend(b.context.iter());
                v.extend(b.key.iter());
                v
            }
            Node::AwaitBlock(b) => {
                let mut v = vec![&b.expression];
                v.extend(b.value.iter());
                v.extend(b.error.iter());
                v
            }
            Node::KeyBlock(b) => vec![&b.expression],
            Node::SnippetBlock(b) => {
                let mut v = vec![&b.expression];
                v.extend(b.parameters.iter());
                v
            }
            Node::OtherTag(o) => vec![&o.node],
            Node::Text(_) | Node::Comment(_) | Node::Component(_) | Node::RegularElement(_)
            | Node::SpecialElement(_) | Node::SvelteOptions(_) => vec![],
        }
    }

    /// The node's child fragments (element bodies, block arms). Used to descend the
    /// template without the generic `walk` (e.g. the dead-branch scan, which needs
    /// custom recursion control at `{#if}` nodes).
    pub fn child_fragments(&self) -> Vec<&Fragment> {
        match self {
            Node::Component(e) | Node::RegularElement(e) | Node::SpecialElement(e) | Node::SvelteOptions(e) => vec![&e.fragment],
            Node::SvelteComponent(d) | Node::SvelteElement(d) => vec![&d.fragment],
            Node::IfBlock(b) => {
                let mut v = vec![&b.consequent];
                v.extend(b.alternate.iter());
                v
            }
            Node::EachBlock(b) => {
                let mut v = vec![&b.body];
                v.extend(b.fallback.iter());
                v
            }
            Node::AwaitBlock(b) => [&b.pending, &b.then, &b.catch].into_iter().flatten().collect(),
            Node::KeyBlock(b) => vec![&b.fragment],
            Node::SnippetBlock(b) => vec![&b.body],
            Node::Text(_) | Node::Comment(_) | Node::ExpressionTag(_) | Node::HtmlTag(_)
            | Node::ConstTag(_) | Node::DebugTag(_) | Node::RenderTag(_) | Node::AttachTag(_)
            | Node::OtherTag(_) => vec![],
        }
    }
}

impl Attribute {
    /// The attribute's JS Value — its `value` (Attribute/Bind/Class/Style) or
    /// `expression` (Spread), or the raw directive node (Other). `None` for none.
    pub fn value(&self) -> Option<&Value> {
        match self {
            Attribute::Attribute(a) | Attribute::Bind(a) | Attribute::Class(a) | Attribute::Style(a) => Some(&a.value),
            Attribute::Spread(e) => Some(&e.expr),
            Attribute::Other(o) => Some(&o.node),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn converts_core_template_nodes() {
        let ast = json!({
            "type": "Root",
            "fragment": { "type": "Fragment", "nodes": [
                { "type": "Component", "name": "Child", "start": 0, "end": 9,
                  "attributes": [ { "type": "Attribute", "name": "x", "start": 8, "end": 11, "value": [] } ],
                  "fragment": { "nodes": [] } },
                { "type": "IfBlock", "start": 10, "end": 20, "elseif": false,
                  "test": { "type": "Identifier", "name": "a" },
                  "consequent": { "nodes": [ { "type": "Text", "data": "x", "start": 15, "end": 16 } ] },
                  "alternate": null },
                { "type": "SvelteComponent", "name": "svelte:component", "start": 21, "end": 30,
                  "expression": { "type": "Identifier", "name": "X" }, "attributes": [], "fragment": { "nodes": [] } }
            ] },
            "instance": Value::Null, "module": Value::Null
        });
        let root = from_value(&ast);
        assert_eq!(root.fragment.nodes.len(), 3);
        match &root.fragment.nodes[0] {
            Node::Component(e) => {
                assert_eq!(e.name, "Child");
                assert_eq!(e.span, Span { start: 0, end: 9 });
                assert_eq!(e.attributes.len(), 1);
            }
            _ => panic!("expected Component"),
        }
        match &root.fragment.nodes[1] {
            Node::IfBlock(b) => {
                assert!(!b.elseif);
                assert_eq!(b.consequent.nodes.len(), 1);
                assert!(b.alternate.is_none());
                assert_eq!(b.test["name"], "a");
            }
            _ => panic!("expected IfBlock"),
        }
        match &root.fragment.nodes[2] {
            Node::SvelteComponent(d) => assert_eq!(d.expr["name"], "X"),
            _ => panic!("expected SvelteComponent"),
        }
    }

    /// The IR-consuming `template_bindings_ir` must produce the same shadowed / debug
    /// / written sets as the Value `template_bindings` on an AST exercising every
    /// binder + write kind (each context/index, snippet name/params, await value/error,
    /// const, debug, `let:`, `bind:`, and an event-handler `x++` write in embedded JS).
    #[test]
    fn template_bindings_ir_matches_value() {
        let id = |n: &str| json!({ "type": "Identifier", "name": n });
        let ast = json!({
            "type": "Root",
            "instance": { "content": { "body": [
                { "type": "VariableDeclaration", "declarations": [
                    { "type": "VariableDeclarator", "id": id("local"), "init": json!(null) } ] },
                { "type": "ExpressionStatement", "expression": {
                    "type": "AssignmentExpression", "operator": "=", "left": id("assigned"),
                    "right": { "type": "Literal", "value": 1 } } }
            ] } },
            "fragment": { "type": "Fragment", "nodes": [
                { "type": "EachBlock", "start": 0, "end": 1,
                  "expression": id("items"),
                  "context": { "type": "ObjectPattern", "properties": [
                      { "type": "Property", "key": id("k"), "value": id("item") } ] },
                  "index": "i", "body": { "nodes": [] } },
                { "type": "SnippetBlock", "start": 2, "end": 3,
                  "expression": id("row"), "parameters": [ id("p") ], "body": { "nodes": [] } },
                { "type": "AwaitBlock", "start": 4, "end": 5, "expression": id("promise"),
                  "value": id("val"), "error": id("err") },
                { "type": "ConstTag", "start": 6, "end": 7, "declaration": {
                    "type": "VariableDeclaration", "declarations": [
                        { "type": "VariableDeclarator", "id": id("c"), "init": id("x") } ] } },
                { "type": "DebugTag", "start": 8, "end": 9, "identifiers": [ id("watched") ] },
                { "type": "RegularElement", "name": "input", "start": 10, "end": 11,
                  "attributes": [
                      { "type": "BindDirective", "name": "value", "start": 12, "end": 13, "expression": id("bound") },
                      { "type": "LetDirective", "name": "slotv", "start": 14, "end": 15 },
                      { "type": "OnDirective", "name": "click", "start": 16, "end": 17, "expression": {
                          "type": "ArrowFunctionExpression", "params": [], "body": {
                              "type": "UpdateExpression", "operator": "++", "argument": id("count") } } }
                  ],
                  "fragment": { "nodes": [] } }
            ] }
        });
        let sorted = |mut v: Vec<String>| {
            v.sort();
            v.dedup();
            v
        };
        let (vs, vd, vw) = crate::analyze::template_bindings(&ast);
        let root = from_value(&ast);
        let (is, id_, iw) = crate::analyze::template_bindings_ir(&root);
        assert_eq!(sorted(is), sorted(vs), "shadowed");
        assert_eq!(sorted(id_), sorted(vd), "debug");
        assert_eq!(sorted(iw), sorted(vw), "written");
    }

    /// `escaped_components_ir` must equal the Value `escaped_components` on an AST that
    /// reads an imported component as a value from every position: `<svelte:component
    /// this={C}>`, a `{#if}` test, an `{expr}`, an attribute `x={C}`, a `bind:this`,
    /// a member access `C.foo` (only the object escapes), and the instance script.
    #[test]
    fn escaped_components_ir_matches_value() {
        use std::collections::{HashMap, HashSet};
        let id = |n: &str| json!({ "type": "Identifier", "name": n });
        let etag = |n: &str| json!({ "type": "ExpressionTag", "start": 0, "end": 1, "expression": id(n) });
        let ast = json!({
            "type": "Root",
            "instance": { "content": { "body": [
                { "type": "ExpressionStatement", "expression": {
                    "type": "AssignmentExpression", "operator": "=", "left": id("local"), "right": id("C") } },
                { "type": "ExpressionStatement", "expression": {
                    "type": "CallExpression", "callee": id("use"), "arguments": [ id("D") ] } }
            ] } },
            "fragment": { "type": "Fragment", "nodes": [
                { "type": "SvelteComponent", "name": "svelte:component", "start": 0, "end": 1,
                  "expression": id("C"), "attributes": [], "fragment": { "nodes": [] } },
                { "type": "IfBlock", "start": 2, "end": 3, "elseif": false, "test": id("C"),
                  "consequent": { "nodes": [ etag("D") ] }, "alternate": json!(null) },
                { "type": "RegularElement", "name": "div", "start": 4, "end": 5, "attributes": [
                    { "type": "Attribute", "name": "x", "start": 6, "end": 7, "value": etag("C") },
                    { "type": "BindDirective", "name": "this", "start": 8, "end": 9, "expression": id("D") }
                ], "fragment": { "nodes": [
                    { "type": "ExpressionTag", "start": 10, "end": 11, "expression": {
                        "type": "MemberExpression", "object": id("C"), "property": id("prop"), "computed": false } }
                ] } }
            ] }
        });
        let imports: HashMap<String, String> =
            [("C".to_string(), "/C.svelte".to_string()), ("D".to_string(), "/D.svelte".to_string())].into();
        let imported: HashSet<String> = ["C".to_string(), "D".to_string()].into();
        let ns: HashSet<String> = HashSet::new();
        let via_value = crate::analyze::escaped_components(&ast, &imports, &imported, &ns);
        let via_ir = crate::analyze::escaped_components_ir(&from_value(&ast), &imports, &imported, &ns);
        assert_eq!(via_ir, via_value);
    }

    /// `compute_dead_spans_ir` (IR walk + Value `decide_chain` via the raw bridge) must
    /// find the same dead spans as the Value `compute_dead_spans`, including the nested
    /// `{#if}` inside a kept arm and the recursion control at elseif/removed nodes.
    #[test]
    fn compute_dead_spans_ir_matches_value() {
        use crate::eval::Literal;
        use std::collections::HashMap;
        let id = |n: &str| json!({ "type": "Identifier", "name": n });
        let lit = |s: &str| json!({ "type": "Literal", "value": s });
        let eq = |l: serde_json::Value, r: serde_json::Value| {
            json!({ "type": "BinaryExpression", "operator": "===", "left": l, "right": r })
        };
        let text = |s: u32, e: u32| json!({ "type": "Text", "data": "x", "start": s, "end": e });
        let ast = json!({
            "type": "Root", "instance": Value::Null, "module": Value::Null,
            "fragment": { "type": "Fragment", "nodes": [
                { "type": "IfBlock", "start": 0, "end": 100, "elseif": false,
                  "test": eq(id("v"), lit("a")),
                  "consequent": { "start": 10, "end": 50, "nodes": [
                      { "type": "IfBlock", "start": 20, "end": 40, "elseif": false,
                        "test": eq(id("v"), lit("b")),
                        "consequent": { "start": 25, "end": 35, "nodes": [ text(26, 34) ] },
                        "alternate": json!(null) }
                  ] },
                  "alternate": { "start": 60, "end": 90, "nodes": [ text(70, 80) ] } }
            ] }
        });
        let env: HashMap<String, Literal> = [("v".to_string(), Literal::Str("a".to_string()))].into();
        let set_env = HashMap::new();
        let via_value = crate::dead_code::compute_dead_spans(&ast["fragment"], &env, &set_env);
        let via_ir = crate::dead_code::compute_dead_spans_ir(&from_value(&ast).fragment, &env, &set_env);
        assert_eq!(via_ir, via_value);
        assert!(!via_value.is_empty(), "the fixture should have dead spans");
    }
}
