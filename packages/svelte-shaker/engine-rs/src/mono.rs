//! L2 per-call-site monomorphization (mono.ts + the transform.ts call-site
//! rewrite): specialize a child into per-site variants when the measured net-win
//! gate proves it strictly shrinks the reachable module bytes.
//!
//! The graph/gate logic is native and reuses the L0/L1/L1.5 substrate
//! (`shake_body`, `compute_dead_spans`, `read_call_site`, `dead_spans_for_plans`),
//! so the ONLY thing crossing back to JS is the per-module size proxy `ownSize`
//! (svelte compile), passed as a callback.  Using the SAME compiler the TS engine
//! uses makes every decision byte-identical; validated by the differential
//! `wasm-mono` test (Rust files+variants == TS svelteShakerWithMono).

use serde_json::Value;
use std::collections::{HashMap, HashSet};

use crate::ast::*;
use crate::dead_code::compute_dead_spans;
use crate::eval::{Env, Literal, SetEnv};
use crate::plan::{dead_spans_for_plans, is_fold_blocked, remap_to_local_names, ComponentPlan, Model, Plans};
use crate::props::{read_call_site, PropDecl};
use crate::shake::{remove_attr_with_space, shake_body};
use crate::transform::MagicEdit;

pub(crate) struct MonoOptions {
    pub(crate) enabled: bool,
    pub(crate) max_variants: usize,
    pub(crate) min_savings: f64,
}

/// One live `<Child/>` site that folds extra literals (a specialization candidate).
pub(crate) struct MonoCandidate {
    pub(crate) owner: String,
    pub(crate) node: Value,
    pub(crate) shape: Vec<(String, Literal)>,
    /// The residual this site folds to — the dedup key.
    pub(crate) code: String,
}

pub(crate) struct MonoBinding {
    pub(crate) owner: String,
    pub(crate) node: Value,
    /// `<childId>?shaker_variant=<n>` request specifier this site resolves to.
    pub(crate) variant_spec: String,
    pub(crate) shape: Vec<(String, Literal)>,
}

/// `<childId>?shaker_variant=<n>` — the request a rewritten call site imports a
/// variant from (mirrors vite.ts `variantSpecifier`, the `::v` form flattened).
pub(crate) fn variant_specifier(child_id: &str, n: usize) -> String {
    format!("{}?shaker_variant={}", child_id, n)
}

/// `<childId>::v<n>` — the variant's stable id, used ONLY as the `filename` the
/// net-win gate sizes it under (mirrors mono.ts `Variant.id`).  The Svelte
/// compiler derives the component function name from the filename, so the gate
/// must size each variant under this exact id to match the TS engine byte-for-byte.
pub(crate) fn variant_id(child_id: &str, n: usize) -> String {
    format!("{}::v{}", child_id, n)
}

/// (env, set_env) for a child's L1 constants PLUS a call site's extra literals;
/// a prop frozen by `extra`/constFold is a constant, so it leaves the narrow set.
pub(crate) fn env_with_extra(plan: &ComponentPlan, extra: &[(String, Literal)]) -> (Env, SetEnv) {
    let mut env: Env = plan.const_env();
    for (k, v) in extra {
        env.insert(k.clone(), v.clone());
    }
    let mut set_env: SetEnv = HashMap::new();
    for (k, v) in &plan.narrow {
        if !env.contains_key(k) {
            set_env.insert(k.clone(), v.clone());
        }
    }
    (env, set_env)
}

/// The residual source for a child under an augmented fold environment — the SAME
/// L0/L1/L1.5 pipeline (`shake_body`) the whole-program transform uses.  Mirrors
/// `renderResidual`; `extra = []` yields the base residual.
pub(crate) fn render_residual(child: &Model, plan: &ComponentPlan, code: &str, extra: &[(String, Literal)]) -> String {
    let (env, set_env) = env_with_extra(plan, extra);
    let mut edits = MagicEdit::new(code);
    let mut dead = Vec::new();
    shake_body(child, &env, &set_env, &mut edits, &mut dead);
    edits.render()
}

/// The live child component ids a residual renders, WITHOUT re-parsing it: a
/// `<Child/>` survives iff its node is not inside a dead `{#if}` span for this
/// fold environment.  Equivalent to mono.ts `liveChildIds(residual)` (the
/// residual is the base with dead-span regions removed), but needs no parser —
/// which the engine does not have in Rust.
pub(crate) fn live_children_for_env(model: &Model, env: &Env, set_env: &SetEnv) -> Vec<String> {
    let local_env = remap_to_local_names(env, model);
    let local_set = remap_to_local_names(set_env, model);
    let dead = compute_dead_spans(get(&model.ast, "fragment"), &local_env, &local_set);
    let mut out = Vec::new();
    for (cid, node) in &model.child_calls {
        if !dead.is_empty() && in_spans(node, &dead) {
            continue;
        }
        out.push(cid.clone());
    }
    out
}

/// The extra props a call site freezes to a literal (declared, not already an
/// app-wide constant, not shadowed/`{@debug}`/nested, literal & no spread can
/// override).  Mirrors `specializableShape`.
pub(crate) fn specializable_shape(node: &Value, child: &Model, plan: &ComponentPlan) -> Vec<(String, Literal)> {
    let site = read_call_site(node);
    let mut declared: HashMap<&str, &PropDecl> = HashMap::new();
    if let Some(pi) = &child.props_info {
        for d in &pi.props {
            declared.insert(d.name.as_str(), d);
        }
    }
    let const_keys: HashSet<&str> = plan.const_fold.iter().map(|(k, _)| k.as_str()).collect();
    let mut shape: Vec<(String, Literal)> = Vec::new();
    for (name, explicit) in &site.explicit {
        let decl = match declared.get(name.as_str()) {
            Some(d) => *d,
            None => continue, // undeclared -> flows to `...rest`
        };
        if const_keys.contains(name.as_str()) {
            continue; // already an app-wide L1 constant
        }
        let local = match &decl.local {
            Some(l) => l,
            None => continue, // nested pattern -> unfoldable
        };
        if is_fold_blocked(child, local) {
            continue;
        }
        if explicit.dynamic || !explicit.after_last_spread {
            continue; // not a literal a spread cannot override
        }
        if let Some(v) = &explicit.value {
            shape.push((name.clone(), v.clone()));
        }
    }
    shape
}

/// The measured net-win gate (the optimized, diff-only form): specialize iff
/// replacing the child with its variants strictly shrinks the module bytes
/// reachable from `roots`.  Only the modules whose size differs between the base
/// and spec scenarios are sized (the rest cancel for `min_savings == 0`).
#[allow(clippy::too_many_arguments)]
pub(crate) fn net_win(
    child_id: &str,
    // (variant id `<childId>::v<n>`, residual code) — the id is the sizing filename.
    variant_specs: &[(String, String)],
    variant_children: &HashMap<String, Vec<String>>,
    base_source: &HashMap<String, String>,
    base_children_of: &HashMap<String, Vec<String>>,
    roots: &[String],
    own_size: &mut dyn FnMut(&str, &str) -> Option<f64>,
    min_savings: f64,
) -> bool {
    // BASE reachability (graph only).
    let mut base_reached: HashSet<String> = HashSet::new();
    let mut stack: Vec<String> = roots.to_vec();
    while let Some(id) = stack.pop() {
        if !base_reached.insert(id.clone()) {
            continue;
        }
        if let Some(ch) = base_children_of.get(&id) {
            for c in ch {
                stack.push(c.clone());
            }
        }
    }

    // SPEC reachability: the child's incoming edges redirect to all its variants.
    let all_specs: Vec<String> = variant_specs.iter().map(|(s, _)| s.clone()).collect();
    let mut spec_components: HashSet<String> = HashSet::new();
    let mut spec_variants: HashSet<String> = HashSet::new();
    let mut comp_stack: Vec<String> = Vec::new();
    let mut var_stack: Vec<String> = Vec::new();
    for r in roots {
        if r == child_id {
            var_stack.extend(all_specs.iter().cloned());
        } else {
            comp_stack.push(r.clone());
        }
    }
    while !comp_stack.is_empty() || !var_stack.is_empty() {
        if let Some(id) = comp_stack.pop() {
            if !spec_components.insert(id.clone()) {
                continue;
            }
            if let Some(ch) = base_children_of.get(&id) {
                for c in ch {
                    if c == child_id {
                        var_stack.extend(all_specs.iter().cloned());
                    } else {
                        comp_stack.push(c.clone());
                    }
                }
            }
            continue;
        }
        let vid = var_stack.pop().unwrap();
        if !spec_variants.insert(vid.clone()) {
            continue;
        }
        if let Some(ch) = variant_children.get(&vid) {
            for c in ch {
                if c == child_id {
                    var_stack.extend(all_specs.iter().cloned());
                } else {
                    comp_stack.push(c.clone());
                }
            }
        }
    }

    // Size only the symmetric difference.  Each module is sized under its own id as
    // the compiler `filename` (the Svelte function name derives from it).
    let mut base_side = 0f64;
    let mut spec_side = 0f64;
    for id in &base_reached {
        if spec_components.contains(id) {
            continue; // shared -> cancels
        }
        match own_size(id, base_source.get(id).map(String::as_str).unwrap_or("")) {
            Some(s) => base_side += s,
            None => return false,
        }
    }
    for (vid, code) in variant_specs {
        if !spec_variants.contains(vid) {
            continue;
        }
        match own_size(vid, code) {
            Some(s) => spec_side += s,
            None => return false,
        }
    }
    for id in &spec_components {
        if base_reached.contains(id) {
            continue; // folding never adds reachability; defensive
        }
        match own_size(id, base_source.get(id).map(String::as_str).unwrap_or("")) {
            Some(s) => spec_side += s,
            None => return false,
        }
    }

    if min_savings == 0.0 {
        return spec_side < base_side;
    }
    let mut shared = 0f64;
    for id in &base_reached {
        if !spec_components.contains(id) {
            continue;
        }
        match own_size(id, base_source.get(id).map(String::as_str).unwrap_or("")) {
            Some(s) => shared += s,
            None => return false,
        }
    }
    spec_side + shared < (base_side + shared) * (1.0 - min_savings)
}

/// Compute the L2 variants + call-site bindings.  Mirrors `monomorphize` in
/// mono.ts; pure over models/plans except the JS `own_size` callback.
pub(crate) fn monomorphize(
    models: &[Model],
    plans: &Plans,
    code_by_id: &HashMap<String, String>,
    entries: &[String],
    opts: &MonoOptions,
    own_size: &mut dyn FnMut(&str, &str) -> Option<f64>,
) -> (Vec<(String, String)>, Vec<MonoBinding>) {
    let mut variants: Vec<(String, String)> = Vec::new();
    let mut bindings: Vec<MonoBinding> = Vec::new();
    if !opts.enabled {
        return (variants, bindings);
    }

    let models_by_id: HashMap<&str, &Model> = models.iter().map(|m| (m.id.as_str(), m)).collect();
    let dead_spans = dead_spans_for_plans(models, plans);

    // base residual + base render graph (computed once for all candidates).
    let mut base_source: HashMap<String, String> = HashMap::new();
    let mut base_children_of: HashMap<String, Vec<String>> = HashMap::new();
    for m in models {
        let plan = &plans[&m.id];
        let code = code_by_id.get(&m.id).map(String::as_str).unwrap_or("");
        if plan.bail {
            base_source.insert(m.id.clone(), code.to_string());
            base_children_of.insert(m.id.clone(), m.child_calls.iter().map(|(c, _)| c.clone()).collect());
        } else {
            base_source.insert(m.id.clone(), render_residual(m, plan, code, &[]));
            base_children_of.insert(m.id.clone(), live_children_for_env(m, &plan.const_env(), &plan.set_env()));
        }
    }

    // (1) gather, per child, every live site that folds a non-base residual.
    let mut child_order: Vec<String> = Vec::new();
    let mut live_sites: HashMap<String, Vec<MonoCandidate>> = HashMap::new();
    let mut ineligible: HashSet<String> = HashSet::new();
    for owner in models {
        let empty = Vec::new();
        let dead = dead_spans.get(&owner.id).unwrap_or(&empty);
        for (child_id, node) in &owner.child_calls {
            if !dead.is_empty() && in_spans(node, dead) {
                continue; // dead site
            }
            let child = match models_by_id.get(child_id.as_str()) {
                Some(c) => *c,
                None => continue,
            };
            let child_plan = match plans.get(child_id) {
                Some(p) => p,
                None => continue,
            };
            let no_props = child.props_info.as_ref().map(|p| p.props.is_empty()).unwrap_or(true);
            if child_plan.bail || no_props {
                ineligible.insert(child_id.clone());
                continue;
            }
            let shape = specializable_shape(node, child, child_plan);
            if shape.is_empty() {
                ineligible.insert(child_id.clone());
                continue;
            }
            let code = render_residual(
                child,
                child_plan,
                code_by_id.get(child_id).map(String::as_str).unwrap_or(""),
                &shape,
            );
            if base_source.get(child_id).map(|b| b == &code).unwrap_or(false) {
                ineligible.insert(child_id.clone());
                continue;
            }
            if !live_sites.contains_key(child_id) {
                child_order.push(child_id.clone());
            }
            live_sites.entry(child_id.clone()).or_default().push(MonoCandidate {
                owner: owner.id.clone(),
                node: node.clone(),
                shape,
                code,
            });
        }
    }

    // Reachability roots = entries not rendered by anyone (true import roots).
    let mut incoming: HashSet<&String> = HashSet::new();
    for ids in base_children_of.values() {
        for c in ids {
            incoming.insert(c);
        }
    }
    let roots: Vec<String> = entries
        .iter()
        .filter(|e| models_by_id.contains_key(e.as_str()) && !incoming.contains(e))
        .cloned()
        .collect();

    let candidate_children: HashSet<String> =
        child_order.iter().filter(|c| !ineligible.contains(*c)).cloned().collect();

    // (3) decide each candidate child against the base scenario.
    for child_id in &child_order {
        if ineligible.contains(child_id) {
            continue;
        }
        let sites = &live_sites[child_id];
        // A live-site owner is itself a candidate -> declining avoids base+variant
        // bloat (nested specialization is a documented followup).
        if sites.iter().any(|s| &s.owner != child_id && candidate_children.contains(&s.owner)) {
            continue;
        }
        // Dedup residuals into the variant set, capped by maxVariants.  Each variant
        // is keyed for the net-win gate by its id (`<childId>::v<n>`, the sizing
        // filename) and emitted to the Shell by its specifier (`?shaker_variant=n`).
        let mut residual_to_n: HashMap<String, usize> = HashMap::new();
        let mut nw_variants: Vec<(String, String)> = Vec::new(); // (variant id, code)
        let mut nw_children: HashMap<String, Vec<String>> = HashMap::new();
        let child_model = models_by_id[child_id.as_str()];
        let child_plan = &plans[child_id];
        let mut over_cap = false;
        for site in sites {
            if residual_to_n.contains_key(&site.code) {
                continue;
            }
            if nw_variants.len() >= opts.max_variants {
                over_cap = true;
                break;
            }
            let n = nw_variants.len();
            residual_to_n.insert(site.code.clone(), n);
            let vid = variant_id(child_id, n);
            let (env, set_env) = env_with_extra(child_plan, &site.shape);
            nw_children.insert(vid.clone(), live_children_for_env(child_model, &env, &set_env));
            nw_variants.push((vid, site.code.clone()));
        }
        if over_cap {
            continue;
        }
        if !net_win(
            child_id,
            &nw_variants,
            &nw_children,
            &base_source,
            &base_children_of,
            &roots,
            own_size,
            opts.min_savings,
        ) {
            continue;
        }
        // Emit variants (keyed by specifier) + bind every live site.
        for (n, (_vid, code)) in nw_variants.iter().enumerate() {
            variants.push((variant_specifier(child_id, n), code.clone()));
        }
        for site in sites {
            let n = residual_to_n[&site.code];
            bindings.push(MonoBinding {
                owner: site.owner.clone(),
                node: site.node.clone(),
                variant_spec: variant_specifier(child_id, n),
                shape: site.shape.clone(),
            });
        }
    }

    (variants, bindings)
}

/// Rewrite each bound `<Child …>` site to import + render a specialized variant,
/// stripping the frozen-prop attributes.  Mirrors `rewriteBoundCallSites`.
pub(crate) fn rewrite_bound_call_sites(
    models_by_id: &HashMap<&str, &Model>,
    bindings: &[MonoBinding],
    code_by_id: &HashMap<String, String>,
    edits_map: &mut HashMap<String, MagicEdit>,
) {
    let mut owner_order: Vec<String> = Vec::new();
    let mut by_owner: HashMap<String, Vec<&MonoBinding>> = HashMap::new();
    for b in bindings {
        if !by_owner.contains_key(&b.owner) {
            owner_order.push(b.owner.clone());
        }
        by_owner.entry(b.owner.clone()).or_default().push(b);
    }
    for owner_id in &owner_order {
        let model = match models_by_id.get(owner_id.as_str()) {
            Some(m) => *m,
            None => continue,
        };
        let code = match code_by_id.get(owner_id) {
            Some(c) => c.as_str(),
            None => continue,
        };
        let edits = match edits_map.get_mut(owner_id) {
            Some(e) => e,
            None => continue,
        };
        let list = &by_owner[owner_id];
        let mut local_for: HashMap<String, String> = HashMap::new();
        let mut imports_to_add: Vec<(String, String)> = Vec::new();
        let mut counter = 0usize;
        for b in list {
            let original = b.node.get("name").and_then(Value::as_str).unwrap_or("Cmp");
            let local = match local_for.get(&b.variant_spec) {
                Some(l) => l.clone(),
                None => {
                    let l = format!("{}__shaker_v{}", original, counter);
                    counter += 1;
                    local_for.insert(b.variant_spec.clone(), l.clone());
                    imports_to_add.push((l.clone(), b.variant_spec.clone()));
                    l
                }
            };
            rewrite_one_site(code, &b.node, &local, &b.shape, edits);
        }
        if !imports_to_add.is_empty() {
            inject_imports(model, &imports_to_add, edits);
        }
    }
}

/// The greatest `p <= from` with `haystack[p..p+needle.len()] == needle`
/// (UTF-16 units) — the `String.prototype.lastIndexOf(needle, from)` analog.
pub(crate) fn rfind_u16(haystack: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    let max_start = from.min(haystack.len() - needle.len());
    let mut p = max_start as isize;
    while p >= 0 {
        let i = p as usize;
        if &haystack[i..i + needle.len()] == needle {
            return Some(i);
        }
        p -= 1;
    }
    None
}

/// Rewrite one `<Child …>` open (and matching close) tag name to `local` and strip
/// the frozen-prop attributes.  Mirrors `rewriteOneSite`; offsets are UTF-16 units.
pub(crate) fn rewrite_one_site(code: &str, node: &Value, local: &str, frozen: &[(String, Literal)], edits: &mut MagicEdit) {
    let name = match node.get("name").and_then(Value::as_str) {
        Some(n) => n,
        None => return,
    };
    let units: Vec<u16> = code.encode_utf16().collect();
    let name_u: Vec<u16> = name.encode_utf16().collect();
    let start = off(node, "start") as usize;
    let end = off(node, "end") as usize;

    let open_name_start = start + 1;
    if open_name_start + name_u.len() <= units.len()
        && units[open_name_start..open_name_start + name_u.len()] == name_u[..]
    {
        edits.overwrite(open_name_start, open_name_start + name_u.len(), local);
    }
    // `</name` — the last occurrence at or before node.end (this element's own close).
    let marker: Vec<u16> = format!("</{}", name).encode_utf16().collect();
    if let Some(close_idx) = rfind_u16(&units, &marker, end.min(units.len())) {
        if close_idx >= start {
            let from = close_idx + 2; // skip `</`
            edits.overwrite(from, from + name_u.len(), local);
        }
    }
    // Remove the frozen-prop attributes (the variant hard-codes them).
    let frozen_names: HashSet<&str> = frozen.iter().map(|(k, _)| k.as_str()).collect();
    for attr in arr(node, "attributes") {
        if type_of(attr) != Some("Attribute") {
            continue;
        }
        let an = match attr.get("name").and_then(Value::as_str) {
            Some(a) => a,
            None => continue,
        };
        if frozen_names.contains(an) {
            remove_attr_with_space(attr, edits);
        }
    }
}

/// Inject `import <local> from "<spec>";` lines into the owner's instance script
/// (or a fresh `<script>` when it has none).  Mirrors `injectImports`.
pub(crate) fn inject_imports(model: &Model, imports: &[(String, String)], edits: &mut MagicEdit) {
    let lines = imports
        .iter()
        .map(|(local, spec)| {
            let quoted = serde_json::to_string(spec).unwrap_or_else(|_| format!("\"{}\"", spec));
            format!("  import {} from {};", local, quoted)
        })
        .collect::<Vec<_>>()
        .join("\n");

    let instance = model.ast.get("instance").filter(|v| !v.is_null());
    let body = instance
        .and_then(|i| i.get("content"))
        .and_then(|c| c.get("body"))
        .and_then(Value::as_array);
    if let Some(b) = body {
        if let Some(last) = b.last() {
            edits.append_left(off(last, "end") as usize, &format!("\n{}", lines));
            return;
        }
    }
    if let Some(content) = instance.and_then(|i| i.get("content")).filter(|v| !v.is_null()) {
        edits.append_left(off(content, "start") as usize, &format!("\n{}\n", lines));
        return;
    }
    edits.prepend(&format!("<script>\n{}\n</script>\n", lines));
}
