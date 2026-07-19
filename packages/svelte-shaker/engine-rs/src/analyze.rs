//! Single-component analysis: declared props, fold-blocking bindings, the
//! `<svelte:options>` bail, rendered child calls, and escaped components.

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

use crate::ast::*;
use crate::props::{count_props_calls, PropsInfo};

/// Imported components LEAKED as a value bail reason (analyze.ts §4.1).
pub(crate) const ESCAPE_REASON: &str = "escapes as value (e.g. <svelte:component this={X}>)";

/// Bail reason for a component the JS revert cascade force-bails because its
/// emitted source failed to re-parse (index.ts `REVERT_REASON`).
pub(crate) const REVERT_REASON: &str = "reverted: transform emitted unparseable source";

/// Bail reason for a component with a consumer OUTSIDE the analyzed `.svelte`
/// graph — a `.ts`/`.js` call site the crawl cannot parse, or a user `external`
/// (analyze.ts §4.2, `AnalyzeInput.escaped`).  Kept byte-identical to the TS
/// engine's `EXTERNAL_ESCAPE_REASON` so the two engines agree.
pub(crate) const EXTERNAL_ESCAPE_REASON: &str = "has a consumer outside the analyzed .svelte graph";

/// The declared prop names (the `Property` keys of the `let { ... } = $props()`
/// `ObjectPattern`, a `...rest` skipped) plus whether such a rest element exists
/// — mirrors `findPropsDeclaration` + the prop loop in analyze.ts.
pub(crate) fn declared_props(ast: &Value) -> (Vec<String>, bool) {
    let body = match ast
        .get("instance")
        .and_then(|i| i.get("content"))
        .and_then(|c| c.get("body"))
        .and_then(Value::as_array)
    {
        Some(b) => b,
        None => return (Vec::new(), false),
    };

    for stmt in body {
        if !str_eq(stmt, "type", "VariableDeclaration") {
            continue;
        }
        for decl in arr(stmt, "declarations") {
            let init = get(decl, "init");
            let id = get(decl, "id");
            let is_props_call = str_eq(init, "type", "CallExpression")
                && str_eq(get(init, "callee"), "type", "Identifier")
                && str_eq(get(init, "callee"), "name", "$props");
            if !is_props_call || !str_eq(id, "type", "ObjectPattern") {
                continue;
            }
            let mut names = Vec::new();
            let mut has_rest = false;
            for p in arr(id, "properties") {
                match type_of(p) {
                    // `...rest` holds only UNDECLARED props — not a declared name.
                    Some("RestElement") => has_rest = true,
                    Some("Property") => {
                        let key = get(p, "key");
                        if str_eq(key, "type", "Identifier") {
                            if let Some(name) = key.get("name").and_then(Value::as_str) {
                                names.push(name.to_string());
                            }
                        }
                    }
                    _ => {}
                }
            }
            return (names, has_rest); // the first `$props()` destructuring wins
        }
    }
    (Vec::new(), false)
}

/// Names bound OUTSIDE the `$props()` pattern (a same-named prop is a different
/// entity there, so it must never be folded), names used as `{@debug}`
/// arguments, and names the component WRITES TO (reassign / `++` / destructure
/// assign / `bind:`). Mirrors `collectTemplateBindings` in analyze.ts. The
/// `$props()` destructuring binds via an `ObjectPattern`, never an
/// `Identifier`/function param, so it is naturally excluded by the branches below.
pub(crate) fn template_bindings(ast: &Value) -> (Vec<String>, Vec<String>, Vec<String>) {
    let mut shadowed = Vec::new();
    let mut debug = Vec::new();
    let mut written = Vec::new();

    // Instance-script `let` / `function` declarations and function parameters.
    walk(get(ast, "instance"), &mut |node| {
        match type_of(node) {
            Some("VariableDeclarator") | Some("FunctionDeclaration") => {
                let id = get(node, "id");
                if str_eq(id, "type", "Identifier") {
                    if let Some(n) = id.get("name").and_then(Value::as_str) {
                        push_unique(&mut shadowed, n);
                    }
                }
            }
            _ => {}
        }
        if matches!(
            type_of(node),
            Some("FunctionDeclaration") | Some("FunctionExpression") | Some("ArrowFunctionExpression")
        ) {
            for param in arr(node, "params") {
                add_pattern_names(param, &mut shadowed);
            }
        }
        collect_written(node, &mut written);
    });

    // Template-scope binders + `{@debug}` arguments + template writes (`bind:`,
    // event-handler assignments/updates).
    walk(get(ast, "fragment"), &mut |node| {
        collect_written(node, &mut written);
        match type_of(node) {
        Some("EachBlock") => {
            add_pattern_names(get(node, "context"), &mut shadowed);
            if let Some(i) = node.get("index").and_then(Value::as_str) {
                push_unique(&mut shadowed, i);
            }
        }
        Some("SnippetBlock") => {
            let expr = get(node, "expression");
            if str_eq(expr, "type", "Identifier") {
                if let Some(n) = expr.get("name").and_then(Value::as_str) {
                    push_unique(&mut shadowed, n);
                }
            }
            for p in arr(node, "parameters") {
                add_pattern_names(p, &mut shadowed);
            }
        }
        Some("AwaitBlock") => {
            add_pattern_names(get(node, "value"), &mut shadowed);
            add_pattern_names(get(node, "error"), &mut shadowed);
        }
        Some("LetDirective") => {
            if let Some(n) = node.get("name").and_then(Value::as_str) {
                push_unique(&mut shadowed, n);
            }
        }
        Some("ConstTag") => {
            for d in arr(get(node, "declaration"), "declarations") {
                add_pattern_names(get(d, "id"), &mut shadowed);
            }
        }
        Some("DebugTag") => {
            for ident in arr(node, "identifiers") {
                if str_eq(ident, "type", "Identifier") {
                    if let Some(n) = ident.get("name").and_then(Value::as_str) {
                        push_unique(&mut debug, n);
                    }
                }
            }
        }
        _ => {}
        }
    });

    (shadowed, debug, written)
}

/// Add the names an assignment / update expression or `bind:` directive WRITES to
/// `out`: a bare-identifier target (`p = …`, `p++`), a destructuring assignment
/// (`({ p } = obj)`), or a two-way `bind:value={p}` / `bind:this={p}`. A
/// MemberExpression target (`o.x = …`) is an object mutation, not a scalar-prop
/// rebind, so `add_pattern_names` ignores it. Mirrors `collectWrittenNames` +
/// the `BindDirective` case in analyze.ts.
fn collect_written(node: &Value, out: &mut Vec<String>) {
    match type_of(node) {
        Some("AssignmentExpression") => add_pattern_names(get(node, "left"), out),
        Some("UpdateExpression") => {
            let arg = get(node, "argument");
            if str_eq(arg, "type", "Identifier") {
                if let Some(n) = arg.get("name").and_then(Value::as_str) {
                    push_unique(out, n);
                }
            }
        }
        Some("BindDirective") => {
            let expr = get(node, "expression");
            if str_eq(expr, "type", "Identifier") {
                if let Some(n) = expr.get("name").and_then(Value::as_str) {
                    push_unique(out, n);
                }
            }
        }
        _ => {}
    }
}

/// EXTERNAL names of props DECLARED but never READ (docs §PR7) — mirrors
/// analyze.ts `computeUnreadDeclaredProps`.  A declared prop is unread when no
/// value-position reference to its LOCAL binding survives anywhere in the instance
/// script or template (reusing `is_value_use` + the `is_type_only_node` prune, so
/// TS type positions do not count as reads).  Its own declaration positions in the
/// pattern are excluded; default expressions ARE scanned.  Conservative: a prop is
/// kept when the `$props()` shape is not a clean single-call ObjectPattern, when it
/// binds a nested pattern (`local` is `None`), or when its local is shadowed /
/// written / a `{@debug}` argument.
pub(crate) fn compute_unread_declared(
    ast: &Value,
    props_info: &Option<PropsInfo>,
    shadowed: &HashSet<String>,
    debug: &HashSet<String>,
    written: &HashSet<String>,
) -> HashSet<String> {
    let pi = match props_info {
        Some(pi) if !pi.props.is_empty() => pi,
        _ => return HashSet::new(),
    };
    // A second `$props()` call can alias the props object and read a prop via
    // member access the local-name scan cannot see, so only a single clean call is
    // eligible.  A `...rest` is fine (it never captures a DECLARED prop).
    if count_props_calls(get(ast, "instance")) != 1 {
        return HashSet::new();
    }
    let mut external_by_local: HashMap<String, String> = HashMap::new();
    for decl in &pi.props {
        if let Some(local) = &decl.local {
            if !shadowed.contains(local) && !debug.contains(local) && !written.contains(local) {
                external_by_local.insert(local.clone(), decl.name.clone());
            }
        }
    }
    if external_by_local.is_empty() {
        return HashSet::new();
    }
    // Declaration identifier spans in the `$props()` pattern (each property's key
    // and its local binding); the scan does not count them as reads, but default
    // expressions ARE scanned (a `{ a, b = a }` reads `a`).
    let mut decl_spans: HashSet<(i64, i64)> = HashSet::new();
    for p in arr(&pi.pattern, "properties") {
        if type_of(p) != Some("Property") {
            continue;
        }
        let key = get(p, "key");
        if !key.is_null() {
            decl_spans.insert((off(key, "start"), off(key, "end")));
        }
        let value = get(p, "value");
        match type_of(value) {
            Some("Identifier") => {
                decl_spans.insert((off(value, "start"), off(value, "end")));
            }
            Some("AssignmentPattern") => {
                let left = get(value, "left");
                if str_eq(left, "type", "Identifier") {
                    decl_spans.insert((off(left, "start"), off(left, "end")));
                }
            }
            _ => {}
        }
    }
    let mut read_locals: HashSet<String> = HashSet::new();
    scan_reads(get(ast, "instance"), &external_by_local, &decl_spans, &mut read_locals);
    scan_reads(get(ast, "fragment"), &external_by_local, &decl_spans, &mut read_locals);

    let mut unread = HashSet::new();
    for (local, name) in &external_by_local {
        if !read_locals.contains(local) {
            unread.insert(name.clone());
        }
    }
    unread
}

/// Record every candidate local read as a value in `root` (outside its own
/// declaration positions and TS type subtrees).
fn scan_reads(
    root: &Value,
    external_by_local: &HashMap<String, String>,
    decl_spans: &HashSet<(i64, i64)>,
    read_locals: &mut HashSet<String>,
) {
    let not_type = |n: &Value| !is_type_only_node(n);
    walk_parented_pruned(root, None, &not_type, &mut |node, parent| {
        if str_eq(node, "type", "Identifier") {
            if let Some(name) = node.get("name").and_then(Value::as_str) {
                if external_by_local.contains_key(name)
                    && !decl_spans.contains(&(off(node, "start"), off(node, "end")))
                    && is_value_use(node, parent)
                {
                    read_locals.insert(name.to_string());
                }
            }
        }
    });
}

/// Whole-component bail reasons: `<svelte:options accessors|customElement>` makes
/// props externally settable, so the component is left untouched (analyze.ts §4.1).
pub(crate) fn component_bail(ast: &Value) -> Vec<String> {
    let mut reasons = Vec::new();
    walk(ast, &mut |node| {
        if str_eq(node, "type", "SvelteOptions") {
            for a in arr(node, "attributes") {
                if str_eq(a, "type", "Attribute") {
                    if let Some(name) = a.get("name").and_then(Value::as_str) {
                        if name == "accessors" || name == "customElement" {
                            reasons.push(format!("<svelte:options {name}>"));
                        }
                    }
                }
            }
        }
    });
    reasons
}

/// Every imported local name (svelte or not), from the instance script's import
/// declarations — needed for escape detection. Mirrors `importSources`' locals.
pub(crate) fn imported_locals(ast: &Value) -> HashSet<String> {
    let mut set = HashSet::new();
    let body = get(get(ast, "instance"), "content");
    for stmt in arr(body, "body") {
        if str_eq(stmt, "type", "ImportDeclaration") {
            for spec in arr(stmt, "specifiers") {
                if let Some(n) = get(spec, "local").get("name").and_then(Value::as_str) {
                    set.insert(n.to_string());
                }
            }
        }
    }
    set
}

/// Build the tag-name -> child-id attribution map from a component's resolved
/// outgoing edges.  Every edge kind (`default-svelte`, `barrel`, `namespace`) is
/// attributable: its `local` is the exact tag a call site renders — a bare name
/// (`Child`) or a dotted member (`ns.Child`) — so all of them feed the value sets.
pub(crate) fn edge_imports(edges: &Value) -> HashMap<String, String> {
    let mut imports = HashMap::new();
    for e in edges.as_array().map(Vec::as_slice).unwrap_or(&[]) {
        if let (Some(l), Some(t)) = (
            e.get("local").and_then(Value::as_str),
            e.get("to").and_then(Value::as_str),
        ) {
            imports.insert(l.to_string(), t.to_string());
        }
    }
    imports
}

/// Each `<Child .../>` this component renders that resolves to a default-`.svelte`
/// import, paired with its source span. Mirrors `collectChildCalls`.
pub(crate) fn child_calls(ast: &Value, imports: &HashMap<String, String>) -> Vec<Value> {
    let mut out = Vec::new();
    walk(get(ast, "fragment"), &mut |node| {
        if str_eq(node, "type", "Component") {
            if let Some(id) = node.get("name").and_then(Value::as_str).and_then(|n| imports.get(n)) {
                out.push(json!({ "childId": id, "start": get(node, "start"), "end": get(node, "end") }));
            }
        }
    });
    out
}

/// Namespace import locals (`import * as ns`).  If `ns` is read as a value the
/// whole namespace escapes, so every `ns.*` member must bail (see `flag_escape`).
pub(crate) fn namespace_locals(ast: &Value) -> HashSet<String> {
    let mut set = HashSet::new();
    let body = get(get(ast, "instance"), "content");
    for stmt in arr(body, "body") {
        if str_eq(stmt, "type", "ImportDeclaration") {
            for spec in arr(stmt, "specifiers") {
                if str_eq(spec, "type", "ImportNamespaceSpecifier") {
                    if let Some(n) = get(spec, "local").get("name").and_then(Value::as_str) {
                        set.insert(n.to_string());
                    }
                }
            }
        }
    }
    set
}

/// Flag the component(s) a leaked local `name` escapes: the one it directly binds,
/// plus — when `name` is a namespace object — every `ns.*` member it could render.
pub(crate) fn flag_escape(
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

/// Imported components LEAKED as a value (escape, analyze.ts §4.1): an import
/// referenced as an ordinary value (e.g. `<svelte:component this={X}>` or
/// assigned/passed in the instance script) rather than only as a `<X .../>` tag.
pub(crate) fn escaped_components(
    ast: &Value,
    imports: &HashMap<String, String>,
    imported: &HashSet<String>,
    namespace_locals: &HashSet<String>,
) -> Vec<String> {
    let mut out = Vec::new();
    let not_type = |n: &Value| !is_type_only_node(n);
    // Template: any imported local read as a value (the dominant `<svelte:component
    // this={X}>` case) — only flag those that resolve to a `.svelte` import.
    // Type-only subtrees are skipped: erased at compile, never a runtime escape.
    walk_parented_pruned(get(ast, "fragment"), None, &not_type, &mut |node, parent| {
        if str_eq(node, "type", "Identifier") {
            if let Some(name) = node.get("name").and_then(Value::as_str) {
                if imported.contains(name) && is_value_use(node, parent) {
                    flag_escape(name, imports, namespace_locals, &mut out);
                }
            }
        }
    });
    // Instance script: a component assigned to a var, pushed into an array, passed
    // to a function, etc. (import-specifier slots are excluded by `is_value_use`).
    // Skip TS type positions (`ComponentProps<typeof X>`, `: Props`): type-level,
    // not value reads, so descending would falsely escape the component.
    walk_parented_pruned(get(ast, "instance"), None, &not_type, &mut |node, parent| {
        if str_eq(node, "type", "Identifier") {
            if let Some(name) = node.get("name").and_then(Value::as_str) {
                if (imports.contains_key(name) || namespace_locals.contains(name))
                    && is_value_use(node, parent)
                {
                    flag_escape(name, imports, namespace_locals, &mut out);
                }
            }
        }
    });
    sorted(out)
}
