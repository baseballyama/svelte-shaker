//! Generic JSON-AST leaf utilities: field access, walks, spans, and the
//! value-use / non-reference predicates shared across the analysis and transform.

use serde_json::Value;

const NULL: Value = Value::Null;

/// `node[key] === val` for a string field, false if absent or non-string.
pub(crate) fn str_eq(node: &Value, key: &str, val: &str) -> bool {
    node.get(key).and_then(Value::as_str) == Some(val)
}

pub(crate) fn type_of(node: &Value) -> Option<&str> {
    node.get("type").and_then(Value::as_str)
}

pub(crate) fn get<'a>(node: &'a Value, key: &str) -> &'a Value {
    node.get(key).unwrap_or(&NULL)
}

/// Strip TypeScript assertion wrappers — `x as T` (`TSAsExpression`), `x!`
/// (`TSNonNullExpression`), `x satisfies T` (`TSSatisfiesExpression`) — to the
/// runtime expression they wrap, recursing so `('a' as const)!` becomes `'a'`.
/// These type operators erase before any code runs, so the wrapped operand's
/// value IS the whole expression's; reading through them folds a `lang="ts"` AST
/// (which carries these nodes) identically to a parser that strips them. Mirrors
/// `unwrapTsAssertions` in eval.ts.
pub(crate) fn unwrap_ts_assertions(node: &Value) -> &Value {
    let mut current = node;
    while matches!(
        type_of(current),
        Some("TSAsExpression") | Some("TSNonNullExpression") | Some("TSSatisfiesExpression")
    ) {
        current = get(current, "expression");
    }
    current
}

pub(crate) fn arr<'a>(node: &'a Value, key: &str) -> &'a [Value] {
    node.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

pub(crate) fn push_unique(out: &mut Vec<String>, name: &str) {
    if !out.iter().any(|x| x == name) {
        out.push(name.to_string());
    }
}

/// Visit every object node in `root` (depth-first), calling `f` on each. The
/// analog of a zimmerframe walk whose visitor descends unconditionally.
pub(crate) fn walk(root: &Value, f: &mut impl FnMut(&Value)) {
    match root {
        Value::Object(map) => {
            f(root);
            for v in map.values() {
                walk(v, f);
            }
        }
        Value::Array(items) => {
            for v in items {
                walk(v, f);
            }
        }
        _ => {}
    }
}

/// Add every identifier bound by a (possibly destructuring) pattern — bare
/// identifiers, object/array destructuring, defaults and rest. Mirrors
/// `addPatternNames` in analyze.ts.
pub(crate) fn add_pattern_names(pat: &Value, out: &mut Vec<String>) {
    // A non-null-asserted assignment target keeps its `TSNonNullExpression` wrapper
    // in every position but a bare `x = …` LHS — `x! += 1`, `[x!] = a`, `({k: x!} =
    // o)` — so peel it at this single choke point every pattern position recurses
    // through, to count the write against the bare name.
    let pat = unwrap_ts_assertions(pat);
    match type_of(pat) {
        Some("Identifier") => {
            if let Some(n) = pat.get("name").and_then(Value::as_str) {
                push_unique(out, n);
            }
        }
        Some("ObjectPattern") => {
            for p in arr(pat, "properties") {
                match type_of(p) {
                    Some("RestElement") => add_pattern_names(get(p, "argument"), out),
                    // `{ a }` / `{ a: b }` — the binding is the property *value*
                    // (falling back to the key for shorthand without an explicit value).
                    Some("Property") => {
                        let value = p.get("value").filter(|v| !v.is_null());
                        add_pattern_names(value.unwrap_or_else(|| get(p, "key")), out);
                    }
                    _ => {}
                }
            }
        }
        Some("ArrayPattern") => {
            for el in arr(pat, "elements") {
                add_pattern_names(el, out);
            }
        }
        Some("AssignmentPattern") => add_pattern_names(get(pat, "left"), out),
        Some("RestElement") => add_pattern_names(get(pat, "argument"), out),
        _ => {}
    }
}

pub(crate) fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v.dedup();
    v
}

/// Visit every object node depth-first WITH its nearest object parent (arrays are
/// transparent — an element's parent is the object owning the array), mirroring
/// zimmerframe's `state.parent`. `descend` decides whether to enter an object
/// node: when it returns `false` the node is neither visited nor recursed into —
/// used to skip TS type-only subtrees in escape detection (see
/// `is_type_only_node`). Pass `&|_| true` for an unconditional walk.
pub(crate) fn walk_parented_pruned<'a, D: Fn(&Value) -> bool, F: FnMut(&Value, Option<&Value>)>(
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

/// A TS type-only subtree the escape walk must NOT descend into: every `TSType*`
/// node (annotations, references/queries, type-argument and type-parameter
/// lists, …) plus `interface` declarations. Identifiers inside them — e.g.
/// `Button` in `ComponentProps<typeof Button>['pattern']`, or `Props` in
/// `: Props` — are type-level, erased at compile, never runtime value reads, so
/// descending would falsely flag the component as escaped and bail it whole.
/// `TSAsExpression` / `TSSatisfiesExpression` / `TSNonNullExpression` /
/// `TSInstantiationExpression` are NOT pruned (they wrap a real runtime
/// expression; their own type child is itself a `TSType*` node this prunes).
/// Mirrors analyze.ts `isTypeOnlyNode`.
pub(crate) fn is_type_only_node(node: &Value) -> bool {
    match type_of(node) {
        Some(t) => t.starts_with("TSType") || t == "TSInterfaceDeclaration",
        None => false,
    }
}

/// Like `walk_parented_pruned`, but always descends and also threads the
/// grandparent (the nearest object ancestor of the parent).  Arrays are not
/// nodes, so they pass parent and grandparent through unchanged.
pub(crate) fn walk_grandparented<'a, F: FnMut(&Value, Option<&Value>, Option<&Value>)>(
    node: &'a Value,
    parent: Option<&'a Value>,
    grandparent: Option<&'a Value>,
    f: &mut F,
) {
    match node {
        Value::Object(map) => {
            f(node, parent, grandparent);
            for v in map.values() {
                walk_grandparented(v, Some(node), parent, f);
            }
        }
        Value::Array(items) => {
            for v in items {
                walk_grandparented(v, parent, grandparent, f);
            }
        }
        _ => {}
    }
}

pub(crate) fn bool_field(node: &Value, key: &str) -> bool {
    node.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// Two AST nodes are the same node iff their source spans coincide — a reliable
/// identity proxy (no two nodes share a `start`), used in place of the JS `===`.
pub(crate) fn same_node(a: &Value, b: &Value) -> bool {
    a.get("start").is_some() && a.get("start") == b.get("start") && a.get("end") == b.get("end")
}

pub(crate) fn is_import_specifier_position(parent: &Value) -> bool {
    matches!(
        type_of(parent),
        Some("ImportSpecifier")
            | Some("ImportDefaultSpecifier")
            | Some("ImportNamespaceSpecifier")
            | Some("ExportSpecifier")
    )
}

/// Is this Identifier a runtime *value* read (so a component name here escapes)?
/// Property keys, member names, and import/export specifier slots are not.
/// Mirrors `isValueUse` in analyze.ts.
pub(crate) fn is_value_use(node: &Value, parent: Option<&Value>) -> bool {
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

/// `isNonReference`: an Identifier used as a property key / member name / import
/// specifier slot — not a value read, so a literal must NOT be substituted there.
pub(crate) fn is_non_reference(node: &Value, parent: Option<&Value>) -> bool {
    let p = match parent {
        Some(p) => p,
        None => return false,
    };
    if str_eq(p, "type", "MemberExpression") && !bool_field(p, "computed") && same_node(get(p, "property"), node) {
        return true;
    }
    if str_eq(p, "type", "Property")
        && !bool_field(p, "computed")
        && p.get("shorthand").and_then(Value::as_bool) != Some(true)
        && same_node(get(p, "key"), node)
    {
        return true;
    }
    // TS type-member name (`interface Props { NAME?: T }` / a `{ NAME: T }` type
    // literal / a method signature): the key is a member NAME in a type position,
    // not a value read of a prop, so folding a same-named prop's literal into it
    // would corrupt the type (`width?: number` -> `36?: number`). Mirror of the TS
    // engine's `isNonReference` guard.
    if (str_eq(p, "type", "TSPropertySignature") || str_eq(p, "type", "TSMethodSignature"))
        && !bool_field(p, "computed")
        && same_node(get(p, "key"), node)
    {
        return true;
    }
    is_import_specifier_position(p)
}

pub(crate) type Span = (i64, i64);

pub(crate) fn off(node: &Value, key: &str) -> i64 {
    node.get(key).and_then(Value::as_i64).unwrap_or(0)
}

pub(crate) fn in_spans(node: &Value, spans: &[Span]) -> bool {
    let (s, e) = (off(node, "start"), off(node, "end"));
    spans.iter().any(|&(a, b)| s >= a && e <= b)
}
