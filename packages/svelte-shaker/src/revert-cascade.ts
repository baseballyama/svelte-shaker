import { parseSvelte } from './parse.js';
import { emptyPlan, type ComponentId, type ComponentPlan } from './ir.js';
import type { FileModel } from './analyze.js';

// The engine's last line of defense.  It aims to only ever emit valid,
// behavior-preserving source, so a component whose slimmed output no longer
// re-parses is a transform bug — but reverting ONLY that file is unsound: its
// parent's call-site edits were already made against the now-discarded folded
// child, so the child would render its default with no attribute left to restore
// it.  The cascade instead force-bails every unparseable component and re-runs the
// WHOLE transform, so the parent's edits are recomputed against a child that drops
// nothing.  Should a transform never converge, we fall back to the untouched
// originals for every file — a whole-program no-op, always sound.  The JS engine
// (index.ts) and the WASM engine (wasm-engine.ts) share this skeleton so their
// revert behavior can never drift.

/** How many times we re-run after force-bailing the unparseable components before
 * giving up on a whole-program no-op.  Small on purpose: each pass can only bail
 * MORE components (monotone), so a couple of passes settle any real case; the cap
 * just bounds a pathological transform. */
export const MAX_REVERT_ITERATIONS = 3;

/** Bail reason stamped on a component force-bailed by the revert cascade (shared
 * with the Rust engine, which stamps the same string for a `forceBail` id). */
export const REVERT_REASON = 'reverted: transform emitted unparseable source';

/** The original id + source of one component — the minimum the cascade needs from
 * a {@link FileModel} (JS engine) or a program input file (WASM engine). */
interface OriginalFile {
  id: ComponentId;
  code: string;
}

/** The ids in `out` whose emitted source no longer parses as valid Svelte.  A
 * file left unchanged from its original is skipped (it is the original, already
 * known-good), so only genuinely edited-then-broken files are collected. */
function unparseableIds(
  originals: readonly OriginalFile[],
  out: Record<ComponentId, string>,
): Set<ComponentId> {
  const failed = new Set<ComponentId>();
  for (const file of originals) {
    const code = out[file.id];
    if (code === undefined || code === file.code) continue;
    try {
      parseSvelte(code, file.id);
    } catch {
      failed.add(file.id);
    }
  }
  return failed;
}

/**
 * Run `run`, and if any component's slimmed source fails to re-parse, re-run it
 * with those ids added to the force-bail set, up to {@link
 * MAX_REVERT_ITERATIONS} times; if it never converges, return every file's
 * untouched original.  `run` receives the accumulated set of ids to bail and must
 * honor it (the JS engine force-bails their plans; the WASM engine threads them to
 * Rust as `forceBail`).
 */
export function revertCascade(
  originals: readonly OriginalFile[],
  run: (forceBail: Set<ComponentId>) => Record<ComponentId, string>,
): Record<ComponentId, string> {
  const forceBail = new Set<ComponentId>();
  let out = run(forceBail);
  for (let i = 0; i < MAX_REVERT_ITERATIONS; i++) {
    const failed = unparseableIds(originals, out);
    if (failed.size === 0) return out;
    for (const id of failed) forceBail.add(id);
    out = run(forceBail);
  }
  if (unparseableIds(originals, out).size === 0) return out;
  // Still broken after the cap: revert every file to its original (no-op shake).
  const original: Record<ComponentId, string> = {};
  for (const file of originals) original[file.id] = file.code;
  return original;
}

/** A copy of `plans` with `ids` force-bailed: those components fold nothing, so
 * the re-run leaves their body untouched AND (because they now drop no prop)
 * keeps every parent's call-site attributes for them. */
function forceBailPlans(
  plans: Map<ComponentId, ComponentPlan>,
  ids: Set<ComponentId>,
): Map<ComponentId, ComponentPlan> {
  const next = new Map(plans);
  for (const id of ids) {
    const plan = next.get(id);
    if (!plan) continue;
    next.set(id, { ...emptyPlan(id), bail: true, reasons: [...plan.reasons, REVERT_REASON] });
  }
  return next;
}

/**
 * The JS engine's revert cascade: drive {@link revertCascade} with a transform
 * `runTransform`, force-bailing the plans of any component whose output failed to
 * re-parse before each re-run.  Exposed so the (rare) test that must drive a
 * revert can inject a transform — the engine never triggers it in normal use.
 */
export function shakeWithRevertCascade(
  models: Map<ComponentId, FileModel>,
  plans: Map<ComponentId, ComponentPlan>,
  runTransform: (plans: Map<ComponentId, ComponentPlan>) => Record<ComponentId, string>,
): Record<ComponentId, string> {
  return revertCascade([...models.values()], (forceBail) =>
    runTransform(forceBailPlans(plans, forceBail)),
  );
}
