# CLAUDE.md

## Project overview

**svelte-shaker** is a sound, source-level tree-shaker for Svelte 5 (runes)
components. It runs in the production build, _before_ the Svelte compiler, and
slims each `.svelte` file by partially evaluating it against how the **whole
app** actually uses it: props no call site passes (or always passes the same
value) are folded to their constant, the dead `{#if}` arms behind them are
deleted, those props are dropped from `$props()`, the now-pointless attributes
are removed at every call site, and `<style>` rules whose class can never be
produced are stripped.

It is **sound first**: it never changes what the user sees. When it cannot prove
a transform is safe, it leaves the code untouched (bails). See
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full design.

## Tech stack

- **Language**: TypeScript (ESM, `strict` via `@tsconfig/strictest`).
- **Repo**: pnpm workspace monorepo (`pnpm@9`, Node `>=18`).
- **Engine runtime deps**: `magic-string`, `zimmerframe`. Peer: `svelte@^5`.
- **Build**: Rollup. **Test**: Vitest. **Lint**: oxlint. **Format**: oxfmt.
  **Types**: `tsc --noEmit`.
- **Release**: Changesets → npm, published from GitHub Actions via OIDC
  (`.github/workflows/release.yml`).

## Repository layout

| Path                                   | What it is                                                       | Published? |
| -------------------------------------- | --------------------------------------------------------------- | ---------- |
| `packages/svelte-shaker`               | The engine + `svelte-shaker/vite` and `svelte-shaker/node` entries | **yes**  |
| `packages/rollup-plugin-svelte-shaker` | Plain-Rollup plugin wrapping the engine                         | no (`private`) |
| `packages/example`                     | Tiny app used as an end-to-end shake fixture                    | no (`private`) |
| `packages/site`                        | In-browser playground (SvelteKit + rsvelte), deployed to Pages  | no (`private`) |

The engine is split into an environment-free **Engine** (Svelte-aware analysis +
transform behind a stable IR — no `fs`/`path`) and a thin **Shell** (the
Vite/Rollup plugin that owns file IO and module resolution), so the core can
later be ported to Rust. Keep that boundary: do not reach for Node APIs inside
the Engine.

## Commands

```sh
pnpm build           # build the engine (rollup -c) — needed before typecheck
pnpm test            # vitest run (engine)
pnpm typecheck       # tsc --noEmit
pnpm lint            # oxlint
pnpm format:fix      # oxfmt . (write)   /  pnpm format:check to verify
pnpm all:check       # typecheck + lint + format:check
```

## Domain rules (read before touching the engine)

- **Soundness is non-negotiable.** A transform ships only when it is _provably_
  behavior-preserving for every value the app actually passes; otherwise bail.
  The differential-SSR oracle (`tests/diff.ts`) and the fixtures are what defend
  this — extend them when you add a transform.
- **Golden fixtures are byte-exact.** `packages/svelte-shaker/tests/fixtures/**`
  is compared verbatim; never reformat or hand-edit expected output to make a
  test pass. oxfmt and oxlint are configured to ignore that tree.
- **Build-only by design.** The engine runs in `vite build`, not dev/HMR
  (whole-program analysis is incompatible with HMR locality). Dev is a
  pass-through.
- **`include` must cover the whole app.** Prop elimination is only sound if every
  call site is in scope.

---

## Operating context

- **Audience**: OSS — code that external contributors and end users will read.
- **Readers**: yourself in 6 months, a first-time contributor, an AI agent.

OSS is not the same as "code only I touch." Optimize for **a stranger not getting
confused**, not for your own convenience.

## Core principles

Every line of code must be justified.

| Principle               | Meaning                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------- |
| Simplicity              | No premature abstraction, no features for hypothetical futures. YAGNI.              |
| Consistency             | Match existing patterns. New patterns require an explicit reason.                   |
| Performance             | Don't write N+1 / O(n²) in the first place. Defend with code shape, not profilers.  |
| Security                | Validate at boundaries (external input, file I/O, external APIs). Watch OWASP.      |
| Maintainability         | Write code that you in 6 months and a new contributor can read and understand.      |
| Backwards compatibility | Public API is preserved unless a breaking change is genuinely justified. Follow SemVer. |

## "One way to do one thing"

> A capability has exactly one canonical path through the public API.

Do not add a **parallel API** — a second path that produces the same result as an
existing one — just because it's shorter, more discoverable, or "feels nicer." Reasons:

1. Every reader pays the "which one should I use?" cost on every code review and onboarding.
2. Two APIs = two of everything: docs, tests, types, bundle size, compatibility surface.
3. If the README says "use X for Y" but the library also accepts Z, the docs are lying.

**The rule bends** in two cases:

- An existing path is **misleadingly named** — rename it, don't parallelize. (Pre-1.0:
  rename outright. Post-1.0: deprecate + remove on next major.)
- A capability is reachable but only at an abstraction so low that every real user
  re-implements the same wrapper — graduate the wrapper into the library and **hide
  the low-level path** behind an "escape hatch" subpath.

In both cases the result is still **one path per capability** for the typical user.

## Defensive programming

**Yes at boundaries; no internally.**

| Situation                                    | Defend? | Example                                               |
| -------------------------------------------- | ------- | ----------------------------------------------------- |
| External input (HTTP, CLI args, files)       | **Yes** | Schema-validate, fail loudly on invalid input         |
| External API / third-party calls             | **Yes** | Error handling, retries, timeouts                     |
| Untrusted data (user uploads, etc.)          | **Yes** | Validate / sanitize                                   |
| Already validated upstream                   | No      | Don't re-validate — that's noise                      |
| Already guaranteed by the type system        | No      | Don't write redundant null checks / optional chaining |
| Cases that are impossible by type definition | No      | No "just in case" guards                              |

**Don't swallow exceptions.** Catching and silently returning `null` for unexpected
errors hides bugs. Internal logic that throws is a bug — let it propagate. Invalid
external input should be converted into the appropriate error type, not pretended away.

## Hard "no"s

- **N+1 access**: sequential `await` inside a loop (DB / API / file). Bulk it.
- **O(n²) operations**: `find` / `filter` / linear search inside a loop. Build a Map / Set first.
- **Type-cast escape hatches**: `as unknown as T` and equivalents. Use validation to convert safely.
- **Redundant "just-in-case" checks**: re-validating values whose contract is already met.
- **Magic numbers / strings**: name them as constants.
- **Dead code**: "might use this later," commented-out implementations. Delete.
- **Swallowed exceptions**: `catch` blocks that silently return null. Let errors propagate.
- **Silent breaking changes to public API**: SemVer violation. Always declare in a changeset.

## Comments

Comments explain **why**, not what. Don't restate the identifier; don't reference the
current task/PR/issue (Git history covers that, and these rot); don't mark deleted code.
Do write a comment when the implementation looks weird for a non-obvious reason (past bug,
performance workaround, third-party API quirk), or there's an implicit constraint /
invariant a future reader will step on.

## Use the type system

Branded/newtype IDs to avoid mixing identifiers; discriminated unions to eliminate
invalid states; exhaustiveness checks (`never`) so adding a variant fails to compile;
parse-don't-validate at the boundary so internal code can trust its inputs.

## OSS-specific discipline

### Public API is a contract

Anything mentioned in `README` / `docs` is a contract. **Adding** an export is a minor
bump; **changing** behavior or **removing/renaming** is a breaking change (major, with
prior deprecation past 1.0). Anything not part of the public API must be **explicitly
internal** — if users can import it, they will.

### CHANGELOG is for users, not for you

Write from the user's perspective. A pure-internal-refactor PR doesn't need a changeset;
if it does need one, mark it `chore` so it doesn't show up as user-facing.

### Issues and PRs are a conversation, not a queue

Point at existing docs before writing code. Evaluate feature requests against the "one
way to do one thing" rule. For bug reports, **write a failing test first** — don't fix
what you can't reproduce. See `.claude/skills/issue-triage/SKILL.md`.

## The AI-slop era

**LLM-authored issues, PRs, and review comments are common and tend to be formally
well-structured but substantively thin.** This repository takes a hard line: templates
are mandatory (`.github/workflows/template-compliance.yml` auto-closes non-conforming
issues/PRs), and repeated low-effort AI submissions can lead to a ban. Using AI is fine;
posting AI output without reading it is not — a human is responsible for whether it's
worth a maintainer's time. When Claude works here, **re-read your own output and ask: is
this thin, generic, or templated?** before posting anything public.

## Skills

The `.claude/skills/` directory contains workflow-specific guides.

| Skill                | When to use                                                            |
| -------------------- | ---------------------------------------------------------------------- |
| `pr-workflow`        | Creating a PR                                                          |
| `full-code-review`   | Reviewing a branch from a maintainer's perspective before opening a PR |
| `review-response`    | Responding to GitHub review comments                                   |
| `run-check-and-test` | Running quality checks and tests before commit / PR                    |
| `issue-triage`       | Classifying a GitHub issue and routing it to the right workflow        |

When you add a new skill, append it to this table.
