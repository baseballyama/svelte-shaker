---
name: issue-triage
description: Use to triage a GitHub issue — classify as bug / feature request / question / docs / dependency, apply the right label, and run the appropriate workflow (reproduce + fix-PR for bugs; "one way to do one thing" check + spec for features; answer with code pointer for questions). Invoked when the user mentions an issue number, pastes a GitHub issue URL, or says "triage", "look at", "handle", or "process" an issue.
---

# Issue triage

Triage a GitHub issue end to end: read it, classify it, label it, and run the
workflow that matches its kind.

The user's GitHub handle is the **operator** (referred to as `op` below). When the
issue's author and `op` are different, "the author" means whoever opened the issue.

## Operating principles

- **Stay on the issue you were given.** One issue per invocation. Don't sweep
  related issues unless the user asks.
- **Confirm before public actions.** Posting comments, applying labels, opening PRs,
  @-mentioning anyone: confirm the plan with the user before the first GitHub-
  visible action. After they approve, you can execute the rest of the plan without
  re-confirming each step.
- **Never close the issue yourself.** Triage is routing; closing is the maintainer's
  call.
- **Don't @-mention people who aren't already in the thread.** Specifically, the
  only person you may @-mention is the issue's author, and only when you actually
  need information from them.
- **Match the issue's language.** If the issue is in Japanese, your comment is in
  Japanese. If English, English. Don't switch languages on the author.

## Step 0 — Locate the issue

Resolve what you're working on:

```bash
gh issue view <num> --repo <owner>/<repo> \
  --json number,title,body,labels,author,state,comments
```

If the user pasted an issue body inline rather than a number, work from that and
**confirm the issue number** with the user before posting anything.

Read existing labels and comments before doing anything. Someone may have already
started triaging. Don't duplicate or contradict prior work without addressing it.

## Step 1 — Classify

One of: `bug`, `enhancement` (feature request), `documentation`, `question`,
`dependencies`, or `other`.

| Signal                                                          | Likely class    |
| --------------------------------------------------------------- | --------------- |
| "throws", "wrong output", repro steps + expected vs actual      | bug             |
| "would be nice if", "support for X", "add an option to ..."     | enhancement     |
| "how do I ...", "is this supported?"                            | question        |
| typo / wrong sample / link rot in README or docs                | documentation   |
| renovate / dependabot / lockfile bump                           | dependencies    |
| spam / off-topic / unrelated repo                               | other (invalid) |
| CI flake or build error in the user's environment              | usually question, unless reproducible against a clean checkout — then bug |

Edge cases:

- An issue may mix bug + feature. Pick the **dominant** frame and note the other in
  your triage comment.
- **"It's slow" without numbers** is a question until the reporter provides a
  benchmark or fixture.
- **"It crashes on my file" without the file** is a bug-shaped question. Apply
  `bug` only if you can reproduce. Otherwise apply `question` and ask for the
  fixture.

## Step 2 — Apply the label

Default OSS label set (the template ships with these):

- `bug`, `enhancement`, `documentation`, `question`, `duplicate`, `invalid`,
  `wontfix`, `good first issue`, `help wanted`, `dependencies`

Map class → label:

- bug → `bug`
- enhancement → `enhancement`
- question → `question`
- documentation → `documentation`
- dependencies → `dependencies`
- other / spam → leave unlabeled or apply `invalid` only on explicit user instruction

```bash
gh issue edit <num> --repo <owner>/<repo> --add-label "<label>"
```

Don't remove existing labels unless they directly conflict. If they conflict, note
the conflict in your triage comment so the maintainer can adjust.

## Step 3 — Run the class-specific workflow

### 3a. Bug workflow

Goal: a failing test that pins the bug, then a fix that flips it green, then a PR.

1. **Reproduce in a test first.**
   - Add a failing test in the project's standard test location.
   - Name it after the issue: `issue-<num>` (file name or test name, depending on
     the test framework).
   - Use the smallest fixture that reproduces. Prefer in-memory inputs to
     committing new binary files.
   - The first run **must fail** for the right reason (the symptom from the
     issue), not a setup error. If it passes immediately, either the bug doesn't
     reproduce or the test is wrong — investigate.

2. **If you reproduced it:**
   - Fix the underlying cause, not the symptom.
   - Re-run the test to confirm green.
   - Run the project's quality gates (`run-check-and-test` skill) before opening
     the PR.
   - Branch: `fix/issue-<num>-<short-slug>`.
   - PR (use `pr-workflow` skill):
     - Title: `fix: <summary> (#<num>)`
     - Body: one-line summary, root cause in 2–3 sentences, "Closes #<num>",
       command to verify locally.

3. **If you couldn't reproduce:**
   - Do **not** apply `wontfix` or `invalid` — those are maintainer calls.
   - Post one comment on the issue explaining what you tried (versions, fixture,
     code path) and what specific information you need to make progress (minimal
     fixture, exact version, runtime version, code snippet, full stack trace).
   - @-mention the author (and only the author).
   - Stop. Don't open a speculative PR.

   Skeleton (translate to the issue's language):

   > Thanks for the report! I tried to reproduce against `main` with `<what you
   > tried>` and it succeeded / produced `<actual>`. To move this forward, could
   > you share `<specific thing>`? @<author>

### 3b. Feature request workflow

This project follows the **"one way to do one thing"** policy. See `CLAUDE.md`
("One way to do one thing" section) for the full rationale. Adding a parallel API
to something already supported is rejected by default.

1. **Score against the policy.** Three outcomes:

   - **Reject (most common):** the request adds a parallel API to an existing
     capability (e.g., a convenience helper for something the existing public API
     already supports in one line). Post a comment that:
     - thanks the reporter
     - shows the existing path with a code snippet
     - explains *why* this project does not add a second path (link the relevant
       README / CLAUDE.md section if applicable)
     - leaves the maintainer to close. Do not close yourself.

   - **Accept:** the request enables something genuinely unreachable today, or
     replaces an existing path that's strictly worse. Run the spec → implement →
     PR flow below.

   - **Unclear / needs more info:** post a question comment to the author asking
     for the use case that motivated the request. Stop until they answer.

2. **Spec → implement → PR (only for accepted requests).**

   a. **Spec the change** as a new comment on the original issue. The original
      issue is the tracking issue — don't open a separate one. The spec covers:
      - public API shape (entry points, exported names, types)
      - what existing path it replaces, if any (and a deprecation plan if relevant)
      - test plan (unit + at least one integration / round-trip case)
      - documentation impact

   b. **Pause for `op` approval.** A spec comment commits the project to a
      direction. Wait for the user to say "go" before posting it, and pause again
      before starting implementation if the spec is non-trivial.

   c. **Implement** on a branch `feat/issue-<num>-<short-slug>`. Tests first;
      production code to make them pass. Run the full project quality gate
      (`run-check-and-test`) before opening the PR.

   d. **PR body** includes the spec (or a link to the spec comment), "Closes
      #<num>", and a manual verification step.

### 3c. Question workflow

Answer with a code snippet pointing at the existing API. If the answer is in the
README or `docs/`, link the exact section. **Don't open a PR** unless the question
reveals a documentation gap and the user explicitly asks you to fix it.

```markdown
You can do this with `<existing API>`:

\`\`\`<lang>
<minimal example>
\`\`\`

This is documented in [<section>](<link>). Let me know if that doesn't fit your
case — happy to dig deeper.
```

### 3d. Documentation workflow

- **Small fix** (typo, broken link, wrong code sample) and you've verified the
  correction → fix it. Open a PR `docs: <summary> (#<num>)`.
- **Larger doc rewrite** → treat as a feature request and run 3b.

### 3e. Dependencies workflow

These are usually renovate / dependabot. **Don't intervene** unless the user asks
— the bot has its own workflow, and CI tells the maintainer if a bump is safe. If
a dep bump genuinely breaks something, that's a bug, not a triage item.

### 3f. Other / spam

Don't apply `invalid` yourself. Tell the user what you saw, let them decide.

## Step 4 — Report back to the user

End with a short status to the user (not a GitHub comment): one or two sentences
saying class, label applied, and what happened or what you're waiting on.

If you opened a PR, include the URL. If you posted a comment, quote one line of it
so the user can verify the tone before the maintainer sees it.

## Quick command reference

```bash
# Read the issue
gh issue view <num> --repo <owner>/<repo> \
  --json number,title,body,labels,author,state,comments

# List comments on an issue
gh issue view <num> --repo <owner>/<repo> --comments

# Apply a label
gh issue edit <num> --repo <owner>/<repo> --add-label "<label>"

# Remove a label
gh issue edit <num> --repo <owner>/<repo> --remove-label "<label>"

# Comment on an issue (HEREDOC preserves formatting)
gh issue comment <num> --repo <owner>/<repo> --body "$(cat <<'EOF'
<message>
EOF
)"

# List labels in the repo
gh label list --repo <owner>/<repo>
```
