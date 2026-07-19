//! Whole-program analysis (docs/RUST-MIGRATION.md M4): the per-component plan
//! (const-fold / narrow), the whole-program model, and the usage/plan fixpoint —
//! the Rust port of analyze.ts's buildUsage/buildPlan/valueSetFor + dead.ts's
//! decideChain/computeDeadSpans.  Validated by `plans == TS plans`.

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

use crate::analyze::*;
use crate::ast::*;
use crate::dead_code::compute_dead_spans;
use crate::eval::{Env, Literal, SetEnv};
use crate::props::*;

pub(crate) const MAX_FIXPOINT_ITERATIONS: usize = 10;

pub(crate) struct ComponentPlan {
    pub(crate) id: String,
    pub(crate) bail: bool,
    pub(crate) reasons: Vec<String>,
    pub(crate) const_fold: Vec<(String, Literal)>,
    pub(crate) narrow: Vec<(String, Vec<Literal>)>,
    pub(crate) value_sets: Vec<(String, PropValueSet)>,
}

impl ComponentPlan {
    pub(crate) fn empty(id: &str) -> ComponentPlan {
        ComponentPlan {
            id: id.to_string(),
            bail: false,
            reasons: Vec::new(),
            const_fold: Vec::new(),
            narrow: Vec::new(),
            value_sets: Vec::new(),
        }
    }
    pub(crate) fn const_env(&self) -> Env {
        self.const_fold.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }
    pub(crate) fn set_env(&self) -> SetEnv {
        self.narrow.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }
}

pub(crate) fn is_fold_blocked(model: &Model, name: &str) -> bool {
    model.shadowed.contains(name) || model.debug.contains(name) || model.written.contains(name)
}

/// Remap an env keyed by EXTERNAL prop name (`constFold` / `narrow`) to one keyed
/// by the LOCAL binding name each prop introduces.  Call-site analysis and
/// call-site attribute dropping work off the external name (`prop` in `prop:
/// alias`), but every body/template reference uses the local name (`alias`), so
/// substitution, branch folding and CSS must look values up by local.  A prop in
/// `constFold`/`narrow` always has a single-identifier local by construction
/// (`build_plan` never folds a `None`-local or shadowed prop), so every entry maps
/// cleanly; an external name with no matching declared local is dropped.  Mirrors
/// `remapToLocalNames` in analyze.ts.
pub(crate) fn remap_to_local_names<V: Clone>(map: &HashMap<String, V>, model: &Model) -> HashMap<String, V> {
    if map.is_empty() {
        return map.clone(); // common case: nothing folds
    }
    let mut local_by_name: HashMap<&str, &str> = HashMap::new();
    if let Some(pi) = &model.props_info {
        for decl in &pi.props {
            if let Some(local) = &decl.local {
                local_by_name.insert(&decl.name, local);
            }
        }
    }
    let mut out = HashMap::new();
    for (name, value) in map {
        if let Some(local) = local_by_name.get(name.as_str()) {
            out.insert((*local).to_string(), value.clone());
        }
    }
    out
}

pub(crate) fn build_plan(
    model: &Model,
    sites: Option<&Vec<CallSite>>,
    owner_envs: &OwnerEnvs,
) -> ComponentPlan {
    let mut plan = ComponentPlan::empty(&model.id);
    if !model.bail_reasons.is_empty() {
        plan.bail = true;
        plan.reasons = model.bail_reasons.clone();
        return plan;
    }
    let props = match &model.props_info {
        Some(pi) if !pi.props.is_empty() => &pi.props,
        _ => return plan,
    };
    let sites = match sites {
        Some(s) if !s.is_empty() => s,
        _ => return plan,
    };
    for decl in props {
        // A `None` local is a nested-pattern entry (`prop: { x }`): there is no
        // single identifier to substitute or drop, so it is never foldable.  The
        // shadow guard tests the LOCAL name (the entity the body references): a
        // name also bound elsewhere is a different entity, so folding it corrupts
        // that binding.  Monomorphization honors the SAME two predicates (mono.ts).
        // Value sets and const_fold/narrow stay keyed by the EXTERNAL name below.
        match &decl.local {
            Some(local) if !is_fold_blocked(model, local) => {}
            _ => continue,
        }
        let set = value_set_for(decl, sites, owner_envs);
        let (dynamic, top) = (set.dynamic, set.top);
        let len = set.values.len();
        plan.value_sets.push((decl.name.clone(), set));
        if dynamic || top {
            continue;
        }
        if len == 1 {
            let v = plan.value_sets.last().unwrap().1.values[0].clone();
            plan.const_fold.push((decl.name.clone(), v));
        } else if len >= 2 {
            let vs = plan.value_sets.last().unwrap().1.values.clone();
            plan.narrow.push((decl.name.clone(), vs));
        }
    }
    plan
}

pub(crate) struct Model {
    pub(crate) id: String,
    pub(crate) ast: Value,
    pub(crate) imports: HashMap<String, String>, // tag name -> childId (all edge kinds), for call-site edits
    pub(crate) props_info: Option<PropsInfo>,
    /// The inputs this component can observe (docs §PR4) — drives the reverse pass.
    pub(crate) reachable_inputs: ReachableInputs,
    /// EXTERNAL names of props this component DECLARES but never READS (docs §PR7).
    /// Source-only, computed once here; the transform gates its use on the plan.
    pub(crate) unread_declared: HashSet<String>,
    pub(crate) shadowed: HashSet<String>,
    pub(crate) debug: HashSet<String>,
    /// Prop names the component WRITES TO — never folded (see `is_fold_blocked`).
    pub(crate) written: HashSet<String>,
    /// (childId, the `<Child/>` Component node) for every rendered child.
    pub(crate) child_calls: Vec<(String, Value)>,
    pub(crate) escaped: Vec<String>,
    pub(crate) bail_reasons: Vec<String>,
}

pub(crate) fn build_model_full(id: &str, ast: Value, edges: &[Value]) -> Model {
    let imports = edge_imports(&Value::Array(edges.to_vec()));
    let props_info = declared_props_full(&ast);
    let reachable_inputs = compute_reachable_inputs(&ast, &props_info);
    let (shadowed_vec, debug_vec, written_vec) = template_bindings(&ast);
    let shadowed: HashSet<String> = shadowed_vec.into_iter().collect();
    let debug: HashSet<String> = debug_vec.into_iter().collect();
    let written: HashSet<String> = written_vec.into_iter().collect();
    let unread_declared = compute_unread_declared(&ast, &props_info, &shadowed, &debug, &written);
    let mut bail_reasons = component_bail(&ast);
    if props_info.as_ref().map(|p| p.shares_statement).unwrap_or(false) {
        bail_reasons.push("$props() shares a multi-declarator statement".to_string());
    }
    let mut child_calls = Vec::new();
    walk(get(&ast, "fragment"), &mut |n| {
        if str_eq(n, "type", "Component") {
            if let Some(cid) = n.get("name").and_then(Value::as_str).and_then(|nm| imports.get(nm)) {
                child_calls.push((cid.clone(), n.clone()));
            }
        }
    });
    let imported = imported_locals(&ast);
    let escaped = escaped_components(&ast, &imports, &imported, &namespace_locals(&ast));
    Model {
        id: id.to_string(),
        ast,
        imports,
        props_info,
        reachable_inputs,
        unread_declared,
        shadowed,
        debug,
        written,
        child_calls,
        escaped,
        bail_reasons,
    }
}

pub(crate) type Plans = HashMap<String, ComponentPlan>;

/// Stamp {@link EXTERNAL_ESCAPE_REASON} on every model listed in the input's
/// `escaped` array (analyze.ts §4.2 `stampExternalEscapes`): components with a
/// consumer outside the `.svelte` graph.  Ids not in the program are ignored.  The
/// single injection point `shake_program`, `shake_program_with_mono`,
/// `analyze_program`, and `find_never_passed_props` all share.
pub(crate) fn stamp_external_escapes(models: &mut [Model], input: &Value) {
    let escaped: HashSet<&str> = input
        .get("escaped")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if escaped.is_empty() {
        return;
    }
    for m in models.iter_mut() {
        if escaped.contains(m.id.as_str())
            && !m.bail_reasons.iter().any(|r| r == EXTERNAL_ESCAPE_REASON)
        {
            m.bail_reasons.push(EXTERNAL_ESCAPE_REASON.to_string());
        }
    }
}

pub(crate) fn build_usage(models: &[Model], dead: &HashMap<String, Vec<Span>>) -> HashMap<String, Vec<CallSite>> {
    let mut usage: HashMap<String, Vec<CallSite>> = HashMap::new();
    for model in models {
        let empty = Vec::new();
        let spans = dead.get(&model.id).unwrap_or(&empty);
        for (child_id, node) in &model.child_calls {
            if !spans.is_empty() && in_spans(node, spans) {
                continue; // folded-away call site: excluded from the child's profile
            }
            usage.entry(child_id.clone()).or_default().push(read_call_site(node, Some(model.id.clone())));
        }
    }
    usage
}

/// Each owner's fold + narrow env for this round: the PREVIOUS round's `constFold`
/// and `narrow`, both remapped to LOCAL names (a forwarded expression references
/// props by their local binding). Computed once per owner per round — no O(n²).
/// Mirrors the memoized `ownerEnv` in analyze.ts's buildPlans.
fn owner_envs_for(models: &[Model], prev: &Plans) -> OwnerEnvs {
    let mut envs = OwnerEnvs::new();
    for model in models {
        if let Some(plan) = prev.get(&model.id) {
            if !plan.bail && (!plan.const_fold.is_empty() || !plan.narrow.is_empty()) {
                envs.insert(
                    model.id.clone(),
                    OwnerEnv {
                        fold: remap_to_local_names(&plan.const_env(), model),
                        narrow: remap_to_local_names(&plan.set_env(), model),
                    },
                );
            }
        }
    }
    envs
}

pub(crate) fn build_plans(models: &[Model], usage: &HashMap<String, Vec<CallSite>>, prev: &Plans) -> Plans {
    let owner_envs = owner_envs_for(models, prev);
    models.iter().map(|m| (m.id.clone(), build_plan(m, usage.get(&m.id), &owner_envs))).collect()
}

pub(crate) fn dead_spans_for_plans(models: &[Model], plans: &Plans) -> HashMap<String, Vec<Span>> {
    let mut out = HashMap::new();
    for model in models {
        let plan = &plans[&model.id];
        if plan.bail {
            continue;
        }
        // Dead spans are derived from the TEMPLATE, which references props by their
        // LOCAL binding name — so the fold/narrow envs (keyed by external prop name)
        // must be remapped here.  This MUST match the transform's own remap exactly,
        // or the fixpoint and the edit could disagree on what folds (unsound).
        let env = remap_to_local_names(&plan.const_env(), model);
        let set_env = remap_to_local_names(&plan.set_env(), model);
        let spans = compute_dead_spans(get(&model.ast, "fragment"), &env, &set_env);
        if !spans.is_empty() {
            out.insert(model.id.clone(), spans);
        }
    }
    out
}

pub(crate) fn plans_equal(a: &Plans, b: &Plans) -> bool {
    if a.len() != b.len() {
        return false;
    }
    for (id, pa) in a {
        let pb = match b.get(id) {
            Some(p) => p,
            None => return false,
        };
        if pa.bail != pb.bail || pa.const_fold != pb.const_fold || pa.narrow != pb.narrow {
            return false;
        }
    }
    true
}

pub(crate) fn run_fixpoint(models: &[Model]) -> Plans {
    // Round 0 uses an empty owner env (no folds yet): a forwarded expression folds
    // only when it is a pure literal expression. Each later round evaluates
    // forwarded expressions against the PREVIOUS round's folds (docs §13.1),
    // keeping the derivation order-independent and monotone toward more folding.
    let no_plans: Plans = HashMap::new();
    let mut plans = build_plans(models, &build_usage(models, &HashMap::new()), &no_plans);
    for _ in 0..MAX_FIXPOINT_ITERATIONS {
        let dead = dead_spans_for_plans(models, &plans);
        let next = build_plans(models, &build_usage(models, &dead), &plans);
        if plans_equal(&plans, &next) {
            plans = next;
            break;
        }
        plans = next;
    }
    plans
}

/// Encode a literal for the plan JSON; `undefined` uses a sentinel object so it
/// stays distinct from `null` across the boundary (the differential test mirrors it).
pub(crate) fn literal_to_plan_json(v: &Literal) -> Value {
    match v {
        Literal::Undefined => json!({ "$undefined": true }),
        other => other.to_json(),
    }
}

pub(crate) fn plan_to_json(plan: &ComponentPlan) -> Value {
    let const_fold: serde_json::Map<String, Value> =
        plan.const_fold.iter().map(|(k, v)| (k.clone(), literal_to_plan_json(v))).collect();
    let narrow: serde_json::Map<String, Value> = plan
        .narrow
        .iter()
        .map(|(k, vs)| (k.clone(), Value::Array(vs.iter().map(literal_to_plan_json).collect())))
        .collect();
    let value_sets: serde_json::Map<String, Value> = plan
        .value_sets
        .iter()
        .map(|(k, s)| {
            (
                k.clone(),
                json!({
                    "values": s.values.iter().map(literal_to_plan_json).collect::<Vec<_>>(),
                    "dynamic": s.dynamic,
                    "top": s.top,
                }),
            )
        })
        .collect();
    json!({
        "id": plan.id,
        "bail": plan.bail,
        "reasons": plan.reasons,
        "constFold": const_fold,
        "narrow": narrow,
        "valueSets": value_sets,
    })
}

/// Per-component props that NO call site in the program passes (explicit,
/// `bind:`, spread, or body/`{#snippet}` content). The Rust counterpart of
/// analyze.ts `findNeverPassedProps`: high-confidence only — bailed/escaped
/// components and zero-call-site entries are skipped, and a prop is flagged only
/// when EVERY site neither names it nor carries a spread that could set it. Takes
/// the batched AnalyzeInput Value (files with embedded `ast`, edges) and returns
/// `{ fileId: [{ name, start, end }] }`. Value-in/Value-out so a native (napi)
/// caller never serializes the AST across a boundary.
pub fn find_never_passed_props(input: &Value) -> Value {
    let mut edges_by_from: HashMap<String, Vec<Value>> = HashMap::new();
    for e in input.get("edges").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
        if let Some(from) = e.get("from").and_then(Value::as_str) {
            edges_by_from.entry(from.to_string()).or_default().push(e.clone());
        }
    }
    // Per-file model building is pure and independent, so on native targets we fan
    // it out across cores (it dominates the scan's wall-clock). The order of the
    // resulting `Vec<Model>` is irrelevant — escapes are unioned and usage is keyed
    // by id below — so this is purely a speedup, not a behavior change. wasm has no
    // thread pool, so it stays sequential.
    let files = input.get("files").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let build_one = |f: &Value| -> Option<Model> {
        let id = f.get("id").and_then(Value::as_str)?.to_string();
        let ast = f.get("ast").cloned().unwrap_or(Value::Null);
        let empty = Vec::new();
        let edges = edges_by_from.get(&id).unwrap_or(&empty);
        Some(build_model_full(&id, ast, edges))
    };
    #[cfg(not(target_arch = "wasm32"))]
    let mut models: Vec<Model> = {
        use rayon::prelude::*;
        files.par_iter().filter_map(build_one).collect()
    };
    #[cfg(target_arch = "wasm32")]
    let mut models: Vec<Model> = files.iter().filter_map(build_one).collect();

    // Program-wide escape bail (analyze.ts §4.1), same as analyze_program.
    let mut escaped = HashSet::new();
    for m in &models {
        for id in &m.escaped {
            escaped.insert(id.clone());
        }
    }
    for m in &mut models {
        if escaped.contains(&m.id) && !m.bail_reasons.iter().any(|r| r == ESCAPE_REASON) {
            m.bail_reasons.push(ESCAPE_REASON.to_string());
        }
    }
    // Consumers outside the `.svelte` graph escape too (analyze.ts §4.2), so a prop
    // they pass is never mis-reported as never-passed.
    stamp_external_escapes(&mut models, input);

    // Every textual call site counts (no dead-span filtering): a prop passed only
    // at a folded-away site is still author-written, so we do not flag it.
    let usage = build_usage(&models, &HashMap::new());

    let mut out = serde_json::Map::new();
    for m in &models {
        if !m.bail_reasons.is_empty() {
            continue;
        }
        let props = match &m.props_info {
            Some(p) if !p.props.is_empty() => &p.props,
            _ => continue,
        };
        let sites = match usage.get(&m.id) {
            Some(s) if !s.is_empty() => s,
            _ => continue,
        };
        let mut arr: Vec<Value> = Vec::new();
        for decl in props {
            let maybe_passed =
                sites.iter().any(|s| s.had_spread || s.explicit.contains_key(&decl.name));
            if maybe_passed {
                continue;
            }
            arr.push(json!({
                "name": decl.name,
                "start": off(&decl.property, "start"),
                "end": off(&decl.property, "end")
            }));
        }
        if !arr.is_empty() {
            out.insert(m.id.clone(), Value::Array(arr));
        }
    }
    Value::Object(out)
}
