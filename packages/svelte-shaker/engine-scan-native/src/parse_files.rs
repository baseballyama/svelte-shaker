//! Chatty-protocol Round 1: `parse_files` extraction.
//!
//! Parse one component with rsvelte and pull out only the facts the JS crawl needs
//! to resolve module edges: the instance-script import specifiers, and the
//! component tag names the file renders. This is the whole point of the chatty
//! protocol — the AST stays in Rust; only these small per-file facts cross back.
//!
//! Mirrors three JS functions in `src/analyze.ts` byte-for-byte:
//!  - `importSources` + `importedName` -> [`instance_imports`]
//!  - `renderedComponentTagNames` (bare `<Local>`) and `memberComponentTags`
//!    (dotted `<ns.X>`) -> [`collect_tags`]
//! The `tests/native-parse-files.test.ts` differential test pins the agreement.

use rsvelte_core::ast::arena::with_serialize_arena;
use rsvelte_core::ast::{Fragment, Root, TemplateNode};
use rsvelte_core::{parse, ParseOptions};
use serde_json::{json, Value};

/// One import specifier, mirroring the JS `ImportInfo`.
pub struct ImportSpec {
    pub local: String,
    /// `"default"` for a default import, `"*"` for a namespace import, else the
    /// source's exported name (falling back to `local` for shorthand).
    pub imported: String,
    pub source: String,
}

/// The per-file result: what `parse_files` reports for one component.
pub struct FileParse {
    pub id: String,
    pub imports: Vec<ImportSpec>,
    /// Bare rendered component tags (`<Local>`), sorted + deduped (the JS side is a
    /// `Set`, so order/dups are not observable — sorting makes the output stable).
    pub rendered_tags: Vec<String>,
    /// Dotted rendered component tags (`<ns.X>` -> `"ns.X"`), sorted + deduped.
    pub member_tags: Vec<String>,
    /// True when rsvelte could not parse the file (JS-side parse failures skip it).
    pub parse_error: bool,
}

impl FileParse {
    pub fn into_json(self) -> Value {
        let imports: Vec<Value> = self
            .imports
            .into_iter()
            .map(|s| json!({ "local": s.local, "imported": s.imported, "source": s.source }))
            .collect();
        json!({
            "id": self.id,
            "imports": imports,
            "renderedTags": self.rendered_tags,
            "memberTags": self.member_tags,
            "parseError": self.parse_error,
        })
    }
}

/// Mirror of JS `importedName`: the specifier's exported name — an `Identifier`
/// `name`, or a string-literal `imported.value` (`import { "x" as y }`) — else `None`.
fn imported_name(spec: &Value) -> Option<String> {
    let imported = spec.get("imported")?;
    match imported.get("type").and_then(Value::as_str) {
        Some("Identifier") => imported.get("name").and_then(Value::as_str).map(str::to_string),
        Some("Literal") => match imported.get("value") {
            Some(Value::String(s)) => Some(s.clone()),
            _ => None,
        },
        _ => None,
    }
}

/// Mirror of JS `importSources`: every `import … from "source"` specifier in the
/// INSTANCE script, in source order. Module-script imports are intentionally
/// excluded — the JS crawl only reads `ast.instance`. `program` is the instance
/// `content` Program as JSON.
fn instance_imports(program: &Value) -> Vec<ImportSpec> {
    let mut out = Vec::new();
    let body = match program.get("body").and_then(Value::as_array) {
        Some(b) => b,
        None => return out,
    };
    for stmt in body {
        if stmt.get("type").and_then(Value::as_str) != Some("ImportDeclaration") {
            continue;
        }
        let source = match stmt.get("source").and_then(|s| s.get("value")).and_then(Value::as_str) {
            Some(v) => v.to_string(),
            None => continue,
        };
        let specs = match stmt.get("specifiers").and_then(Value::as_array) {
            Some(s) => s,
            None => continue,
        };
        for spec in specs {
            let local = match spec.get("local").and_then(|l| l.get("name")).and_then(Value::as_str) {
                Some(l) => l.to_string(),
                None => continue,
            };
            // Only the three binding specifiers are imports; anything else is skipped,
            // exactly as the JS `if / else if` chain does (no trailing `else`).
            let imported = match spec.get("type").and_then(Value::as_str) {
                Some("ImportDefaultSpecifier") => "default".to_string(),
                Some("ImportNamespaceSpecifier") => "*".to_string(),
                Some("ImportSpecifier") => imported_name(spec).unwrap_or_else(|| local.clone()),
                _ => continue,
            };
            out.push(ImportSpec { local, imported, source: source.clone() });
        }
    }
    out
}

/// Walk the whole template, recording every `<Component>` tag by name. Dotted names
/// (`<ns.X>`) go to `member`, bare names to `rendered` — the same split the two JS
/// walks make. Exhaustive over `TemplateNode` so a new node kind is a COMPILE error
/// here, never a silently-missed nesting site (which would drop a call site).
fn collect_tags(fragment: &Fragment, rendered: &mut Vec<String>, member: &mut Vec<String>) {
    for node in &fragment.nodes {
        walk_node(node, rendered, member);
    }
}

fn walk_node(node: &TemplateNode, rendered: &mut Vec<String>, member: &mut Vec<String>) {
    match node {
        TemplateNode::Component(c) => {
            let name = c.name.as_str();
            if name.contains('.') {
                member.push(name.to_string());
            } else if !name.is_empty() {
                rendered.push(name.to_string());
            }
            collect_tags(&c.fragment, rendered, member);
        }

        TemplateNode::RegularElement(e) => collect_tags(&e.fragment, rendered, member),
        TemplateNode::TitleElement(e) => collect_tags(&e.fragment, rendered, member),
        TemplateNode::SlotElement(e) => collect_tags(&e.fragment, rendered, member),
        TemplateNode::SvelteBody(e)
        | TemplateNode::SvelteDocument(e)
        | TemplateNode::SvelteFragment(e)
        | TemplateNode::SvelteBoundary(e)
        | TemplateNode::SvelteHead(e)
        | TemplateNode::SvelteSelf(e)
        | TemplateNode::SvelteWindow(e) => collect_tags(&e.fragment, rendered, member),
        TemplateNode::SvelteOptions(e) => collect_tags(&e.fragment, rendered, member),
        // `<svelte:component>` / `<svelte:element>` are NOT `Component` tags (the JS
        // walk keys on the `Component` node type), so their tag is never recorded —
        // only their body is walked for nested components.
        TemplateNode::SvelteComponent(e) => collect_tags(&e.fragment, rendered, member),
        TemplateNode::SvelteElement(e) => collect_tags(&e.fragment, rendered, member),

        TemplateNode::IfBlock(b) => {
            collect_tags(&b.consequent, rendered, member);
            if let Some(alt) = &b.alternate {
                collect_tags(alt, rendered, member);
            }
        }
        TemplateNode::EachBlock(b) => {
            collect_tags(&b.body, rendered, member);
            if let Some(fallback) = &b.fallback {
                collect_tags(fallback, rendered, member);
            }
        }
        TemplateNode::AwaitBlock(b) => {
            if let Some(p) = &b.pending {
                collect_tags(p, rendered, member);
            }
            if let Some(t) = &b.then {
                collect_tags(t, rendered, member);
            }
            if let Some(c) = &b.catch {
                collect_tags(c, rendered, member);
            }
        }
        TemplateNode::KeyBlock(b) => collect_tags(&b.fragment, rendered, member),
        TemplateNode::SnippetBlock(b) => collect_tags(&b.body, rendered, member),

        // Leaves: no child fragment can hold a component tag.
        TemplateNode::Text(_)
        | TemplateNode::Comment(_)
        | TemplateNode::ExpressionTag(_)
        | TemplateNode::HtmlTag(_)
        | TemplateNode::ConstTag(_)
        | TemplateNode::DeclarationTag(_)
        | TemplateNode::DebugTag(_)
        | TemplateNode::RenderTag(_)
        | TemplateNode::AttachTag(_) => {}
    }
}

/// Extract the `parse_files` facts from an ALREADY-PARSED `Root`. The serialize
/// arena must be installed by the caller (instance-import extraction resolves
/// JsNodeIds through it). Split out so the Session can compute facts and the shake
/// AST from a single parse.
pub fn facts_from_root(id: &str, root: &Root) -> FileParse {
    let imports = match root.instance.as_ref() {
        Some(script) => instance_imports(script.content.as_json()),
        None => Vec::new(),
    };
    let mut rendered = Vec::new();
    let mut member = Vec::new();
    collect_tags(&root.fragment, &mut rendered, &mut member);
    rendered.sort();
    rendered.dedup();
    member.sort();
    member.dedup();
    FileParse { id: id.to_string(), imports, rendered_tags: rendered, member_tags: member, parse_error: false }
}

/// Parse one component and extract its `parse_files` facts. A parse error yields an
/// empty result flagged `parse_error` (the JS crawl simply cannot follow such a
/// file), never a panic.
pub fn parse_one(id: &str, code: &str) -> FileParse {
    let root: Root = match parse(code, ParseOptions::default()) {
        Ok(root) => root,
        Err(_) => {
            return FileParse {
                id: id.to_string(),
                imports: Vec::new(),
                rendered_tags: Vec::new(),
                member_tags: Vec::new(),
                parse_error: true,
            };
        }
    };
    // `as_json()` on the instance program resolves JsNodeIds via the arena.
    with_serialize_arena(&root.arena, || facts_from_root(id, &root))
}
