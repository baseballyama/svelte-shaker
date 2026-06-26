//! Typed prop scanner — the Value-free analysis path (goal B).
//!
//! Walks rsvelte's TYPED `Root` to compute never-passed props directly, instead
//! of serializing the whole AST to `serde_json::Value` and running the Value
//! engine over it. The full-AST Value (the template skeleton — the dominant
//! ~12 MB/650-component allocation) is never built.
//!
//! Two-layer completeness, so nothing the analysis must see is missed:
//!  - The TEMPLATE structure is walked over the typed `TemplateNode` enum. An
//!    exhaustive `match` means a forgotten node kind is a COMPILE error, not a
//!    silent under-visit (which could drop a call site or an escape and produce a
//!    false positive).
//!  - JS EXPRESSIONS (the small instance `<script>` and each embedded template
//!    expression) are visited through rsvelte's `as_json()` and walked
//!    generically — `serde_json` visits every child, so no AST variant can be
//!    missed (rsvelte exposes no typed JS-AST walker; rsvelte_lint itself reads
//!    the JS AST as JSON). This keeps escape detection — the one analysis whose
//!    incompleteness would cause a false positive — provably exhaustive.
//!
//! never-passed needs far less than the full model: `find_never_passed_props`
//! only tests `had_spread || explicit.contains(name)`, so a call site is just
//! `{ had_spread, explicit: set<name> }` — no literal values, value sets,
//! defaults, `local`, or shadow/debug names. The reported span is the `$props()`
//! destructuring `Property`'s; only those few offsets are remapped to UTF-16.
//!
//! Correctness is pinned to the Value engine (itself pinned to the JS engine) by
//! the `scan` vs `scanViaValue` differential test on the flygate corpus.

use std::collections::{HashMap, HashSet};

use rsvelte_core::ast::arena::with_serialize_arena;
use rsvelte_core::ast::js::Expression;
use rsvelte_core::ast::{
    Attribute, AttributeValue, AttributeValuePart, Fragment, Root, TemplateNode,
};
use rsvelte_core::{parse, ParseOptions};
use serde_json::Value;

use crate::utf16::Utf8ToUtf16;

// ===========================================================================
// Value helpers for the JS-AST (instance script + embedded expressions), ported
// verbatim from engine-rs so the escape / $props logic stays byte-identical.
// ===========================================================================

const NULL: Value = Value::Null;

fn type_of(node: &Value) -> Option<&str> {
    node.get("type").and_then(Value::as_str)
}
fn str_eq(node: &Value, key: &str, val: &str) -> bool {
    node.get(key).and_then(Value::as_str) == Some(val)
}
fn get<'a>(node: &'a Value, key: &str) -> &'a Value {
    node.get(key).unwrap_or(&NULL)
}
fn arr<'a>(node: &'a Value, key: &str) -> &'a [Value] {
    node.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}
fn bool_field(node: &Value, key: &str) -> bool {
    node.get(key).and_then(Value::as_bool).unwrap_or(false)
}
/// Two nodes are the same iff their spans coincide (no two nodes share a start).
fn same_node(a: &Value, b: &Value) -> bool {
    a.get("start").is_some() && a.get("start") == b.get("start") && a.get("end") == b.get("end")
}
fn is_import_specifier_position(parent: &Value) -> bool {
    matches!(
        type_of(parent),
        Some("ImportSpecifier")
            | Some("ImportDefaultSpecifier")
            | Some("ImportNamespaceSpecifier")
            | Some("ExportSpecifier")
    )
}
/// Mirror of engine-rs `is_value_use`.
fn is_value_use(node: &Value, parent: Option<&Value>) -> bool {
    let p = match parent {
        Some(p) => p,
        None => return false,
    };
    if str_eq(p, "type", "MemberExpression")
        && !bool_field(p, "computed")
        && same_node(get(p, "property"), node)
    {
        return false;
    }
    if str_eq(p, "type", "Property")
        && !bool_field(p, "computed")
        && p.get("shorthand").and_then(Value::as_bool) != Some(true)
        && same_node(get(p, "key"), node)
    {
        return false;
    }
    if is_import_specifier_position(p) {
        return false;
    }
    true
}
/// Mirror of engine-rs `is_type_only_node`.
fn is_type_only_node(node: &Value) -> bool {
    match type_of(node) {
        Some(t) => t.starts_with("TSType") || t == "TSInterfaceDeclaration",
        None => false,
    }
}
/// Mirror of engine-rs `walk_parented_pruned`.
fn walk_parented_pruned<'a, D: Fn(&Value) -> bool, F: FnMut(&Value, Option<&Value>)>(
    node: &'a Value,
    parent: Option<&'a Value>,
    descend: &D,
    f: &mut F,
) {
    match node {
        Value::Object(map) => {
            if !descend(node) {
                return;
            }
            f(node, parent);
            for v in map.values() {
                walk_parented_pruned(v, Some(node), descend, f);
            }
        }
        Value::Array(items) => {
            for v in items {
                walk_parented_pruned(v, parent, descend, f);
            }
        }
        _ => {}
    }
}
fn push_unique(out: &mut Vec<String>, name: &str) {
    if !out.iter().any(|x| x == name) {
        out.push(name.to_string());
    }
}
/// Mirror of engine-rs `flag_escape`.
fn flag_escape(
    name: &str,
    imports: &HashMap<String, String>,
    namespace_locals: &HashSet<String>,
    out: &mut Vec<String>,
) {
    if let Some(id) = imports.get(name) {
        push_unique(out, id);
    }
    if namespace_locals.contains(name) {
        let prefix = format!("{name}.");
        for (local, id) in imports {
            if local.starts_with(&prefix) {
                push_unique(out, id);
            }
        }
    }
}

// ===========================================================================
// Instance <script> analysis (on the small `content` Program Value).
// ===========================================================================

/// Declared props of the first `let { … } = $props()` destructuring, as
/// `(external_name, property_start, property_end)` in UTF-8 byte offsets, plus
/// whether the declaration shares a multi-declarator statement (a bail). `None`
/// when the component has no `$props()` destructuring. Mirrors
/// `declared_props_full` + the never-passed reporting in engine-rs.
fn declared_props(program: &Value) -> Option<(Vec<(String, u32, u32)>, bool)> {
    let body = program.get("body").and_then(Value::as_array)?;
    for stmt in body {
        if !str_eq(stmt, "type", "VariableDeclaration") {
            continue;
        }
        let decls = arr(stmt, "declarations");
        for decl in decls {
            let init = get(decl, "init");
            let id = get(decl, "id");
            let is_props_call = str_eq(init, "type", "CallExpression")
                && str_eq(get(init, "callee"), "type", "Identifier")
                && str_eq(get(init, "callee"), "name", "$props");
            if !is_props_call || !str_eq(id, "type", "ObjectPattern") {
                continue;
            }
            let mut props = Vec::new();
            for p in arr(id, "properties") {
                if type_of(p) != Some("Property") {
                    continue; // RestElement holds only UNDECLARED props
                }
                let key = get(p, "key");
                if str_eq(key, "type", "Identifier") {
                    if let Some(name) = key.get("name").and_then(Value::as_str) {
                        let start = p.get("start").and_then(Value::as_u64).unwrap_or(0) as u32;
                        let end = p.get("end").and_then(Value::as_u64).unwrap_or(0) as u32;
                        props.push((name.to_string(), start, end));
                    }
                }
            }
            return Some((props, decls.len() > 1));
        }
    }
    None
}

/// Every imported local name + the namespace-import locals (`import * as ns`).
/// Mirrors engine-rs `imported_locals` / `namespace_locals`.
fn import_locals(program: &Value) -> (HashSet<String>, HashSet<String>) {
    let mut imported = HashSet::new();
    let mut namespace = HashSet::new();
    for stmt in arr(program, "body") {
        if !str_eq(stmt, "type", "ImportDeclaration") {
            continue;
        }
        for spec in arr(stmt, "specifiers") {
            if let Some(n) = get(spec, "local").get("name").and_then(Value::as_str) {
                imported.insert(n.to_string());
                if str_eq(spec, "type", "ImportNamespaceSpecifier") {
                    namespace.insert(n.to_string());
                }
            }
        }
    }
    (imported, namespace)
}

/// Escapes from the instance script: an imported local (or namespace object) read
/// as a runtime value. Mirrors engine-rs `escaped_components`' instance walk.
fn instance_escapes(
    program: &Value,
    imports: &HashMap<String, String>,
    namespace_locals: &HashSet<String>,
    out: &mut Vec<String>,
) {
    let not_type = |n: &Value| !is_type_only_node(n);
    walk_parented_pruned(program, None, &not_type, &mut |node, parent| {
        if str_eq(node, "type", "Identifier") {
            if let Some(name) = node.get("name").and_then(Value::as_str) {
                if (imports.contains_key(name) || namespace_locals.contains(name))
                    && is_value_use(node, parent)
                {
                    flag_escape(name, imports, namespace_locals, out);
                }
            }
        }
    });
}

/// Escapes from a single embedded TEMPLATE expression. The engine walks the whole
/// fragment, so a top-level expression Identifier always sits under a value-position
/// parent (`ExpressionTag`, attribute value, `{#if}` test, `this={…}`, …) and counts
/// as a value-use. Serialized alone its root has no parent, so we treat the root as a
/// value position; nested identifiers use the normal parent rule. Mirrors the
/// engine's fragment walk, which keys on `imported_locals` membership.
fn expression_escapes(
    expr_value: &Value,
    imported: &HashSet<String>,
    imports: &HashMap<String, String>,
    namespace_locals: &HashSet<String>,
    out: &mut Vec<String>,
) {
    let not_type = |n: &Value| !is_type_only_node(n);
    let mut first = true;
    walk_parented_pruned(expr_value, None, &not_type, &mut |node, parent| {
        // The root node stands in a value position in the template; deeper nodes
        // use the real parent. (A type-only root is already pruned by `not_type`.)
        let value_use =
            if first { type_of(node) == Some("Identifier") } else { is_value_use(node, parent) };
        first = false;
        if str_eq(node, "type", "Identifier") {
            if let Some(name) = node.get("name").and_then(Value::as_str) {
                if imported.contains(name) && value_use {
                    flag_escape(name, imports, namespace_locals, out);
                }
            }
        }
    });
}

// ===========================================================================
// Template analysis (typed walk over rsvelte's `TemplateNode`).
// ===========================================================================

/// One `<Child …/>` call site, reduced to what never-passed needs.
pub struct CallSite {
    pub had_spread: bool,
    pub explicit: HashSet<String>,
}

/// Whether a spread `{...expr}` is a statically-known object literal, and if so its
/// key names (added to `explicit`). `None` => an opaque spread (`had_spread`).
/// Mirrors engine-rs `known_spread_entries`, keys only.
fn known_spread_keys(expr: &Expression) -> Option<Vec<String>> {
    let obj = expr.as_json();
    if type_of(obj) != Some("ObjectExpression") {
        return None;
    }
    let mut keys = Vec::new();
    for prop in arr(obj, "properties") {
        if type_of(prop) != Some("Property") {
            return None;
        }
        if bool_field(prop, "computed")
            || str_eq(prop, "kind", "get")
            || str_eq(prop, "kind", "set")
            || bool_field(prop, "method")
        {
            return None;
        }
        let key = get(prop, "key");
        let name = match type_of(key) {
            Some("Identifier") => key.get("name").and_then(Value::as_str).map(str::to_string),
            Some("Literal") => match key.get("value") {
                Some(Value::String(s)) => Some(s.clone()),
                Some(Value::Number(n)) => Some(n.to_string()),
                _ => None,
            },
            _ => None,
        };
        keys.push(name?);
    }
    Some(keys)
}

/// Props supplied through a `<Child>…</Child>` body: `children` for any renderable
/// content + one per named `{#snippet}`. Mirrors `synthesized_body_props` (direct
/// children only — not recursive).
fn body_props(fragment: &Fragment, out: &mut HashSet<String>) {
    let mut has_children = false;
    for node in &fragment.nodes {
        match node {
            TemplateNode::SnippetBlock(s) => {
                if let Some(name) = s.expression.identifier_name() {
                    out.insert(name.to_string());
                }
            }
            TemplateNode::Comment(_) => {}
            TemplateNode::Text(t) => {
                if !t.data.trim().is_empty() {
                    has_children = true;
                }
            }
            _ => has_children = true,
        }
    }
    if has_children {
        out.insert("children".to_string());
    }
}

/// Read one typed `<Child …/>` into a `CallSite` (names + spread + body), the
/// never-passed subset of `read_call_site`.
fn read_call_site(attributes: &[Attribute], fragment: &Fragment) -> CallSite {
    let mut explicit = HashSet::new();
    let mut had_spread = false;
    for attr in attributes {
        match attr {
            Attribute::Attribute(node) => {
                explicit.insert(node.name.to_string());
            }
            Attribute::BindDirective(b) => {
                explicit.insert(b.name.to_string());
            }
            Attribute::SpreadAttribute(s) => match known_spread_keys(&s.expression) {
                Some(keys) => explicit.extend(keys),
                None => had_spread = true,
            },
            // on: / use: / let: / class: / style: / transition: / animate: /
            // {@attach} are not props.
            _ => {}
        }
    }
    body_props(fragment, &mut explicit);
    CallSite { had_spread, explicit }
}

/// Whether a `<svelte:options>` element carries an `accessors` / `customElement`
/// attribute (a whole-component bail). Returns the bail reason string if so.
fn svelte_options_bail(attributes: &[Attribute]) -> Vec<String> {
    let mut reasons = Vec::new();
    for attr in attributes {
        if let Attribute::Attribute(node) = attr {
            let name = node.name.as_str();
            if name == "accessors" || name == "customElement" {
                reasons.push(format!("<svelte:options {name}>"));
            }
        }
    }
    reasons
}

/// Accumulator passed through the template walk.
struct TemplateVisitor<'a> {
    imports: &'a HashMap<String, String>,
    imported: &'a HashSet<String>,
    namespace_locals: &'a HashSet<String>,
    /// (childId, call site) for every rendered `<Tag>` that resolves to a child.
    child_calls: Vec<(String, CallSite)>,
    /// Resolved child ids that escape via a template expression.
    escaped: Vec<String>,
    /// `<svelte:options accessors|customElement>` bail reasons.
    bail: Vec<String>,
}

impl TemplateVisitor<'_> {
    fn visit_expr(&mut self, expr: &Expression) {
        expression_escapes(
            expr.as_json(),
            self.imported,
            self.imports,
            self.namespace_locals,
            &mut self.escaped,
        );
    }

    /// Collect escape-relevant expressions from an element's attributes. Mirrors
    /// what the engine's fragment walk would visit inside `attributes`.
    fn visit_attrs(&mut self, attributes: &[Attribute]) {
        for attr in attributes {
            match attr {
                Attribute::Attribute(node) => self.visit_attr_value(&node.value),
                Attribute::SpreadAttribute(s) => self.visit_expr(&s.expression),
                Attribute::AttachTag(a) => self.visit_expr(&a.expression),
                Attribute::BindDirective(b) => self.visit_expr(&b.expression),
                Attribute::OnDirective(d) => {
                    if let Some(e) = &d.expression {
                        self.visit_expr(e);
                    }
                }
                Attribute::ClassDirective(d) => self.visit_expr(&d.expression),
                Attribute::StyleDirective(d) => self.visit_attr_value(&d.value),
                Attribute::TransitionDirective(d) => {
                    if let Some(e) = &d.expression {
                        self.visit_expr(e);
                    }
                }
                Attribute::AnimateDirective(d) => {
                    if let Some(e) = &d.expression {
                        self.visit_expr(e);
                    }
                }
                Attribute::UseDirective(d) => {
                    if let Some(e) = &d.expression {
                        self.visit_expr(e);
                    }
                }
                Attribute::LetDirective(d) => {
                    if let Some(e) = &d.expression {
                        self.visit_expr(e);
                    }
                }
            }
        }
    }

    fn visit_attr_value(&mut self, value: &AttributeValue) {
        match value {
            AttributeValue::True(_) => {}
            AttributeValue::Expression(tag) => self.visit_expr(&tag.expression),
            AttributeValue::Sequence(parts) => {
                for part in parts {
                    if let AttributeValuePart::ExpressionTag(tag) = part {
                        self.visit_expr(&tag.expression);
                    }
                }
            }
        }
    }

    fn visit_fragment(&mut self, fragment: &Fragment) {
        for node in &fragment.nodes {
            self.visit_node(node);
        }
    }

    /// Exhaustive over `TemplateNode`: a new variant forces a compile error here,
    /// so a node kind can never be silently skipped (which could drop a call site
    /// or an escape and cause a false positive).
    fn visit_node(&mut self, node: &TemplateNode) {
        match node {
            TemplateNode::Text(_) | TemplateNode::Comment(_) => {}

            TemplateNode::Component(c) => {
                // A rendered child: record its call site (attributed by tag name),
                // then descend so nested components / expressions are still visited.
                if let Some(id) = self.imports.get(c.name.as_str()) {
                    self.child_calls
                        .push((id.clone(), read_call_site(&c.attributes, &c.fragment)));
                }
                self.visit_attrs(&c.attributes);
                self.visit_fragment(&c.fragment);
            }

            TemplateNode::RegularElement(e) => {
                self.visit_attrs(&e.attributes);
                self.visit_fragment(&e.fragment);
            }
            TemplateNode::TitleElement(e) => {
                self.visit_attrs(&e.attributes);
                self.visit_fragment(&e.fragment);
            }
            TemplateNode::SlotElement(e) => {
                self.visit_attrs(&e.attributes);
                self.visit_fragment(&e.fragment);
            }
            TemplateNode::SvelteBody(e)
            | TemplateNode::SvelteDocument(e)
            | TemplateNode::SvelteFragment(e)
            | TemplateNode::SvelteBoundary(e)
            | TemplateNode::SvelteHead(e)
            | TemplateNode::SvelteSelf(e)
            | TemplateNode::SvelteWindow(e) => {
                self.visit_attrs(&e.attributes);
                self.visit_fragment(&e.fragment);
            }
            TemplateNode::SvelteOptions(e) => {
                self.bail.extend(svelte_options_bail(&e.attributes));
                self.visit_attrs(&e.attributes);
                self.visit_fragment(&e.fragment);
            }
            TemplateNode::SvelteComponent(e) => {
                // `<svelte:component this={X}>`: `X` is a value-use of the import,
                // detected via `expression`; not a static child call site.
                self.visit_expr(&e.expression);
                self.visit_attrs(&e.attributes);
                self.visit_fragment(&e.fragment);
            }
            TemplateNode::SvelteElement(e) => {
                self.visit_expr(&e.tag);
                self.visit_attrs(&e.attributes);
                self.visit_fragment(&e.fragment);
            }

            TemplateNode::ExpressionTag(t) => self.visit_expr(&t.expression),
            TemplateNode::HtmlTag(t) => self.visit_expr(&t.expression),
            TemplateNode::ConstTag(t) => self.visit_expr(&t.declaration),
            TemplateNode::DeclarationTag(t) => self.visit_expr(&t.declaration),
            TemplateNode::DebugTag(t) => {
                for id in &t.identifiers {
                    self.visit_expr(id);
                }
            }
            TemplateNode::RenderTag(t) => self.visit_expr(&t.expression),
            TemplateNode::AttachTag(t) => self.visit_expr(&t.expression),

            TemplateNode::IfBlock(b) => {
                self.visit_expr(&b.test);
                self.visit_fragment(&b.consequent);
                if let Some(alt) = &b.alternate {
                    self.visit_fragment(alt);
                }
            }
            TemplateNode::EachBlock(b) => {
                self.visit_expr(&b.expression);
                if let Some(ctx) = &b.context {
                    self.visit_expr(ctx);
                }
                if let Some(key) = &b.key {
                    self.visit_expr(key);
                }
                self.visit_fragment(&b.body);
                if let Some(fallback) = &b.fallback {
                    self.visit_fragment(fallback);
                }
            }
            TemplateNode::AwaitBlock(b) => {
                self.visit_expr(&b.expression);
                if let Some(v) = &b.value {
                    self.visit_expr(v);
                }
                if let Some(e) = &b.error {
                    self.visit_expr(e);
                }
                if let Some(p) = &b.pending {
                    self.visit_fragment(p);
                }
                if let Some(t) = &b.then {
                    self.visit_fragment(t);
                }
                if let Some(c) = &b.catch {
                    self.visit_fragment(c);
                }
            }
            TemplateNode::KeyBlock(b) => {
                self.visit_expr(&b.expression);
                self.visit_fragment(&b.fragment);
            }
            TemplateNode::SnippetBlock(b) => {
                self.visit_expr(&b.expression);
                for p in &b.parameters {
                    self.visit_expr(p);
                }
                self.visit_fragment(&b.body);
            }
        }
    }
}

// ===========================================================================
// Per-file model + program-wide never-passed.
// ===========================================================================

/// The never-passed model of one component (Value-free).
pub struct FileModel {
    pub id: String,
    /// Declared props `(name, start, end)` (UTF-8 byte offsets), or `None`.
    pub props: Option<Vec<(String, u32, u32)>>,
    pub bail: bool,
    pub escaped: Vec<String>,
    pub child_calls: Vec<(String, CallSite)>,
    /// Source, kept for the UTF-16 remap of reported spans on non-ASCII files.
    pub is_ascii: bool,
}

/// Build the model for one component from its source + resolved import edges
/// (tag name -> child id). Returns `None` only on a parse error (the file is then
/// skipped — sound under-reporting).
pub fn build_model(id: &str, code: &str, imports: &HashMap<String, String>) -> Option<FileModel> {
    let root: Root = parse(code, ParseOptions::default()).ok()?;
    // All `as_json()` calls below need the arena installed to resolve JsNodeIds.
    Some(with_serialize_arena(&root.arena, || build_model_inner(id, code, imports, &root)))
}

fn build_model_inner(
    id: &str,
    code: &str,
    imports: &HashMap<String, String>,
    root: &Root,
) -> FileModel {
    // ---- instance <script>: props, imports, instance escapes ----
    let (props, mut bail, imported, namespace_locals, mut escaped) = match &root.instance {
        Some(script) => {
            let program = script.content.as_json();
            let (imported, namespace_locals) = import_locals(program);
            let mut escaped = Vec::new();
            instance_escapes(program, imports, &namespace_locals, &mut escaped);
            match declared_props(program) {
                Some((props, shares_statement)) => {
                    let bail = if shares_statement {
                        vec!["$props() shares a multi-declarator statement".to_string()]
                    } else {
                        Vec::new()
                    };
                    (Some(props), bail, imported, namespace_locals, escaped)
                }
                None => (None, Vec::new(), imported, namespace_locals, escaped),
            }
        }
        None => (None, Vec::new(), HashSet::new(), HashSet::new(), Vec::new()),
    };

    // ---- template: call sites, svelte:options bail, template escapes ----
    let mut visitor = TemplateVisitor {
        imports,
        imported: &imported,
        namespace_locals: &namespace_locals,
        child_calls: Vec::new(),
        escaped: Vec::new(),
        bail: Vec::new(),
    };
    visitor.visit_fragment(&root.fragment);
    bail.extend(visitor.bail);
    escaped.extend(visitor.escaped);

    FileModel {
        id: id.to_string(),
        props,
        bail: !bail.is_empty(),
        escaped,
        child_calls: visitor.child_calls,
        is_ascii: code.is_ascii(),
    }
}

/// Whole-program never-passed: union escapes -> bail, aggregate call sites per
/// child, then report each declared prop no site passes. Output shape matches the
/// Value engine: `{ fileId: [{ name, start, end }] }` with UTF-16 offsets.
///
/// Borrows the models (never mutates them) so the resident daemon can re-run this
/// cheap whole-program assembly over its cached model set without rebuilding it.
pub fn never_passed(models: &[&FileModel], codes: &HashMap<String, String>) -> Value {
    // Program-wide escape bail (analyze.ts §4.1).
    let mut escaped: HashSet<&str> = HashSet::new();
    for m in models {
        for id in &m.escaped {
            escaped.insert(id.as_str());
        }
    }

    // Aggregate call sites per child id.
    let mut usage: HashMap<&str, Vec<&CallSite>> = HashMap::new();
    for m in models {
        for (child_id, site) in &m.child_calls {
            usage.entry(child_id.as_str()).or_default().push(site);
        }
    }

    // Emit reports in sorted-id order so the output is deterministic regardless of
    // model iteration order — a cold `scan` (parse-order Vec) and the daemon
    // (HashMap) then produce byte-identical JSON for the same program.
    let mut sorted: Vec<&&FileModel> = models.iter().collect();
    sorted.sort_by(|a, b| a.id.cmp(&b.id));

    let mut out = serde_json::Map::new();
    for m in sorted {
        if m.bail || escaped.contains(m.id.as_str()) {
            continue;
        }
        let props = match &m.props {
            Some(p) if !p.is_empty() => p,
            _ => continue,
        };
        let sites = match usage.get(m.id.as_str()) {
            Some(s) if !s.is_empty() => s,
            _ => continue,
        };
        // UTF-16 remap of reported spans for non-ASCII source only.
        let conv = if m.is_ascii {
            None
        } else {
            codes.get(&m.id).map(|c| Utf8ToUtf16::new(c))
        };
        let mut arr: Vec<Value> = Vec::new();
        for (name, start, end) in props {
            let passed =
                sites.iter().any(|s| s.had_spread || s.explicit.contains(name));
            if passed {
                continue;
            }
            let (s16, e16) = match &conv {
                Some(c) => (c.convert(*start as usize) as u64, c.convert(*end as usize) as u64),
                None => (*start as u64, *end as u64),
            };
            arr.push(serde_json::json!({ "name": name, "start": s16, "end": e16 }));
        }
        if !arr.is_empty() {
            out.insert(m.id.clone(), Value::Array(arr));
        }
    }
    Value::Object(out)
}
