//! The engine's internal template IR (docs/RUST-MIGRATION.md M4).
//!
//! One in-memory representation the whole engine consumes, fed by two frontends:
//! `Value → IR` (the wasm path — JSON produced by the JS-side parse) and, behind a
//! non-wasm feature, `rsvelte Root → IR` (the native path). The engine has a single
//! implementation over this IR; only the two converters differ. This replaces the
//! per-round walking + cloning of a `serde_json::Value` template (the dominant shake
//! cost) with a typed, owned tree.
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
    /// The raw AST Value, retained during the migration so not-yet-ported phases can
    /// still read it and the differential pin can compare. Removed in the final slice.
    pub ast: Value,
}
