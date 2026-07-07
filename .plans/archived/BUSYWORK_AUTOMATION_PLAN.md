# Busywork Automation Plan (/review-pr, /fix-ci, docs drift, issue triage, hygiene briefing)

Status: **complete / archived** — implementation landed; README and docs now cover reports,
`/review-pr`, `/fix-ci`, docs drift, issue triage, hygiene, and the Reports panel. Original specification for the next slice of "Neon does the busy work": a
`/review-pr` assigned-review flow (two HTML reports + seeded review drafts), a `/fix-ci`
intake flow, scheduled docs-drift and issue-triage jobs, and a hygiene extension of the morning
briefing, all emitting into a new lightweight **reports** primitive. Written 2026-07-05 against
main `77ab999`; assumes `.plans/CLOSE_DECISION_LOOPS_PLAN.md` lands first (revision runs and
dispatch discipline are reused here). Scope was chosen explicitly: dependency-PR management and
release chores are **out** (owner decision).

## Purpose

Neondeck watches and gates well, but a developer's day contains chores that are neither a PR
event nor a chat conversation: a PR you've been asked to review, a red CI run someone has to go
dig into, docs that quietly rot as code moves, an issue tracker nobody grooms, branches and
worktrees that accumulate. Each of
these has the same shape — **gather facts on a schedule or on request, do bounded agent work in
a sandbox, and hand the human a reviewable artifact** — and Neondeck already owns every hard
part of that shape: scheduler jobs, managed worktrees, Kilo background runs, prepared-diff
review, execution policy, notifications.

What's missing is (a) a durable, rich output surface — today everything degrades to a
notification line or a chat message — and (b) the specific fact-gatherers and prompts. This
plan adds both.

To the framing question "isn't /fix-ci just a custom Flue workflow/agent and a skill?" — yes,
almost exactly: one command, one workflow, one prompt template, **zero new agents and zero new
model-callable capabilities**. The existing `fix_pr_ci_failure` action is a deterministic
applier (it takes an already-decided `patch`, `src/modules/autopilot/schemas.ts:420`); the
reasoning that produces the patch is a Kilo run, same dispatch pattern as the revision runs in
CLOSE_DECISION_LOOPS. The other three features are the same idea pointed at different facts.

## Ground Rules (verified against main `77ab999`, 2026-07-05)

- **Scheduler blueprints are the extension point for recurring jobs.** `BlueprintKind` is a
  four-value picklist (`morning-briefing | watch-pr | release-watch | review-queue-digest`,
  `src/modules/scheduler/schemas.ts:26,78`); `executeJob` dispatches by `job.type`
  (`dispatch.ts:20`) and `defaultIntervalSeconds` sets cadence defaults. Adding a kind means:
  picklist + executor + default interval + blueprint-create validation.
- **CI facts already exist**: `/explain-ci` command (deterministic explanation from queue check
  facts, `src/modules/commands/handlers/queue.ts:56`), `fetchFailingCheckFacts` +
  bounded-Actions-log fetching (`src/modules/autopilot/github-facts.ts`, tested in
  `github.test.ts` "collects failing check facts"), `verify-pr-worktree` and
  `prepare-pr-worktree` workflows.
- **Kilo is the bounded agent executor**: `startKiloTask({ prompt, worktreeId, ... })` with
  persisted task/event state, abort, and deck-rendered diffs; results re-enter review via
  `ensurePreparedDiffForWorktree(..., { resetDecisionState: true })`.
- **Briefing is a deterministic composer**: `briefingCommand`
  (`src/modules/commands/handlers/misc.ts:27`) assembles registry/watches/jobs/notifications/
  queue into `topActions`; the `morning-briefing` job invokes the briefing workflow.
- **Static serving exists**: `serveStatic` already mounts `/assets/*` from the web dist
  (`src/server/create-app.ts:122`); a second mount for report files is one line plus access
  middleware (`requireLocalApiAccess` pattern).
- **Read-only git facts precedent**: `readGitRepoStatus`/`readGitDiffSummary`
  (`src/modules/repos/registry.ts`) run subprocesses through the exec wrapper with timeouts —
  the stale-branch fact-gatherer follows this exactly.
- **GitHub issues are not modeled today.** The github module is PR-centric (the queue's
  "issues" are error items, not tracker issues). Issue triage needs a new, small fetch surface.
- **Trust posture**: outward mutations stay human-gated; agent-produced changes land as
  prepared diffs in the existing review loop; new routes are user-surface-only with safety
  entries. Nothing here adds a model-callable write.

## Non-Goals

- **Dependency-PR management and release chores** — explicitly descoped by the owner.
- **No auto-posted issue comments, auto-closed issues, or auto-deleted branches.** Triage and
  hygiene _report and stage_; destructive/outward actions remain human clicks (branch deletion
  isn't even staged in v1 — it's listed).
- **No repro-execution in issue triage v1.** Attempting to reproduce bugs in worktrees is real
  machinery (and real compute); v1 is classification + digest. Repro runs are a recorded v2
  that rides the same Kilo dispatch.
- **Not a general BI/reporting system.** Reports are write-once HTML artifacts with a listing
  panel — no queries, no dashboards-within-dashboards.
- **No new agents.** The display assistant and Kilo cover reasoning; per-feature behavior is
  prompt/instruction content, not new agent registrations.

## Shared foundation — Reports (build first, everything emits into it)

A minimal artifact store for rich outputs:

- **Table** `reports` (Drizzle + `db:generate`): `id`, `kind`
  (`ci-fix | docs-drift | issue-triage | hygiene | ...` — plain text, no enum migration per
  feature), `title`, `repoId?`, `sourceRef?` (PR/issue/task linkage), `htmlPath` (relative to
  the reports dir), `summaryJson` (small structured digest for the panel row), `createdBy`
  (workflow/run id), `createdAt`. Retention: prune by kind beyond N=50 or 90 days, constants.
- **Files** under `<runtimeHome>/reports/<kind>/<id>.html` — self-contained HTML (inline CSS,
  no external fetches; slide-style layout template shared in `src/lib/report-html.ts` with a
  deck-matching light/dark theme). Writer helper `writeReport({ kind, title, html, ... })`
  returns the record.
- **Serving**: `GET /reports/:id` route resolves the record and serves the file (behind the
  same local-access middleware as `/api`); deck rows open it via the existing pop-out pattern
  (`window.open`).
- **Deck surface**: a thin `ReportsPanel` plugin (list by kind, title, age, open button) plus
  inline "report" affordances on the rows that spawned them (autopilot rows, briefing panel).
- **Safety**: read-only route entry; report writing is a byproduct of already-audited
  workflows, not a new mutation surface.

Sized deliberately small: table + writer + one route + one panel. Every feature below emits
one report kind.

## Feature 1 — `/review-pr`: assigned-review reports + seeded review drafts

The motivating use case: _"I've been asked to review a PR — Neon, do the review pass and give
me something I can work from."_ Output is two slide-style reports plus, where anchors resolve,
pre-seeded draft comments in the deck's PR review surface. **The trust boundary from
`.plans/PR_REVIEW_ACTIONS_PLAN.md` is untouched**: Neon drafts, the human edits, owns the
verdict, and submits. No review-submission capability is created.

**Intake**: `/review-pr <ref>` command and a "neon review" button on GitHubPrList rows. Both
dispatch the `review-pr-for-human` workflow, fire-and-record.

**Workflow** (`src/workflows/review-pr-for-human.ts` + `src/modules/pr-review-assist/`):

1. **Facts**: PR detail, files (existing `getGitHubPrFiles` path — the server-side cache and,
   when it lands, the local-checkout provider give full patches), review threads, check
   summary, linked-issue references from the body.
2. **Agent pass**: bounded run over the diff (Kilo against a read-only checkout when the repo
   is registered, else the patch text alone) producing structured output: an _overview_ (what
   the PR does, how, change map, risk areas) and _findings_ (severity, `path` + new/old-file
   line, one-sentence issue, suggested fix). The output contract is a JSON schema the workflow
   validates — malformed agent output fails the run, it never half-seeds.
3. **Reports** (both `kind: 'pr-review'`): **"PR Overview"** — narrative + per-file change map
   - risk/checks section; **"Review Issues"** — findings ranked by severity with diff excerpts.
     All PR-sourced content HTML-escaped by the report template (PR text is untrusted).
4. **Seed the draft**: for each finding, compute the `side`/`line` anchor and validate it
   against the patch with a server-side port of the frontend's `buildPatchAnchorIndex`
   (`web/src/features/pr-review/review-helpers.ts` — move the pure logic to a shared module
   rather than duplicating). Valid anchors → `upsertPrReviewDraft` (live `headSha`) +
   `addPrReviewDraftComment`, body prefixed with the finding summary + suggested fix.
   Unanchorable findings stay report-only. Add an `origin` column (`'human' | 'neon'`) to
   `pr_review_draft_comments` (`db:generate`) so seeded comments render visually distinct in
   the review UI and are auditable; seeding **never** touches an existing draft that already
   has human comments — in that case findings stay report-only and the notification says so.
5. **Hand-off**: `ready` notification linking both reports and the PR review surface. The
   human opens the deck's existing review view, sees the seeded pending comments, prunes/edits
   (delete and edit affordances already exist), picks the verdict, submits. Staleness handling
   is inherited: if the PR moves, the seeded comments hit the existing stale/re-anchor flow.
6. **Audit**: workflow summary `pr_review_assist` (pr, findingCount, seededCount, reportIds).

## Feature 2 — `/fix-ci` (and a richer `/explain-ci`)

**Intake**: `/fix-ci [pr-ref]` command (registry + parser addition; same PR selection helper
`/explain-ci` uses, preferring failing checks) and a "fix CI" button on failing GitHubPrList /
queue rows. Both dispatch the new `fix-pr-ci` workflow — fire-and-record, run id returned.

**Workflow** (`src/workflows/fix-pr-ci.ts` + `src/modules/autopilot/ci-fix-run.ts`):

1. **Dossier**: gather `fetchFailingCheckFacts` + bounded job logs + PR detail + recent
   commits. Emit the **CI failure dossier report** (`kind: 'ci-fix'`) immediately — what
   failed, the extracted error lines, suspect files, prior related runs. This artifact is the
   enriched `/explain-ci`: the command gains `--report` behavior by reusing exactly this step
   without the fix (and its chat summary links the report).
2. **Worktree**: ensure a managed worktree for the PR (`prepare-pr-worktree` machinery), lock
   it (`lockOwner: 'ci-fix-run'`).
3. **Agent run**: Kilo task against the worktree; prompt = the dossier + bounds (_fix only the
   failing checks; keep the change minimal; run the failing check's command locally through
   execution policy if preapproved; commit locally; never push_). The prompt template is a
   runtime skill (the "skill" in the owner's framing) so it can be tuned without code changes
   — and improved through the learning loop.
4. **Re-entry**: on completion with commits → `ensurePreparedDiffForWorktree` → prepared diff
   → existing verify/approve/revise loop (revision runs from CLOSE_DECISION_LOOPS apply). On
   failure/no-op → unlock, `attention` notification linking the dossier, no diff.
5. **Audit**: workflow summary `ci_fix_run` (pr, checks, kiloTaskId, outcome, reportId).

The prompt template is a **runtime skill** (`NEONDECK_HOME/skills/neon-ci-fix/SKILL.md`,
seeded at bootstrap) rather than a code-adjacent instruction file — see "Memory & learning
integration" below for why.

Overlap note: `fix_pr_ci_failure` (deterministic applier) stays untouched — it remains Neon's
chat-turn path when _it_ already has a concrete patch. `/fix-ci` is the human-initiated,
agent-reasoned path for everything harder. Single-flight per PR via the worktree lock.

## Feature 3 — Docs drift (scheduled job)

**Blueprint** `docs-drift`, default weekly (`defaultIntervalSeconds`: 604 800; daily
configurable via `intervalSeconds`). Per-repo config in the blueprint:
`{ repo, docsGlobs (default "docs/**/*.{md,mdx,astro}"), sourceGlobs? }`.

**Executor** (`src/modules/docs-drift/`): per tick, for each configured repo with a local
checkout:

1. **Watermark**: last scanned commit per repo (job `lastResult`, same pattern as release
   watch). Diff `watermark..origin/<default>` (read-only git facts precedent; fetch first).
2. **Detection v1 — cheap and honest**: changed/renamed/deleted source paths and removed or
   renamed exported symbols (from the diff text) are text-matched against the docs globs. A doc
   page that mentions a moved path, a deleted file, or a vanished symbol is a drift hit.
   Heuristic by design; the report says so. No AST, no embeddings in v1.
3. **Output**: drift report (`kind: 'docs-drift'`) — per page: what it references, what changed,
   the referencing lines — plus one `attention` notification when hits > 0 (silent otherwise;
   scheduler outcome `silent`/`updated` semantics as with watches).
4. **Stage a fix (human click, not automatic)**: each drift group in the report row gets a
   "stage docs fix" action → Kilo run in a managed worktree scoped to the docs globs (prompt:
   the drift facts + _edit only matching docs paths_) → prepared diff → normal review loop.
   Deliberately identical dispatch shape to revision/ci-fix runs.

## Feature 4 — Issue triage (scheduled job)

**New fetch surface** `src/modules/github/issues.ts`: list open issues for configured repos
(REST `GET /repos/:owner/:repo/issues`, paginated, `since` watermark, PRs filtered out by the
`pull_request` key), sanitized shape `{ number, title, labels, authorLogin, assigneeLogins,
createdAt, updatedAt, commentCount, bodyExcerpt }`. Read-only action + safety entry
(`neondeck_github_issues_get`, readOnly) so Neon can also answer issue questions in chat.

**Blueprint** `issue-triage`, default daily (86 400). Config: `{ repo, staleAfterDays: 30,
limit: 100 }`.

**Executor** (`src/modules/issue-triage/`): per tick and repo:

1. Fetch issues since watermark + the open backlog snapshot.
2. **Classify deterministically where possible**: new-since-last-run, stale (> staleAfterDays
   without update), missing-info (heuristic: no body / no repro block), duplicate candidates
   (normalized-title similarity, flagged as _candidate_ only).
3. **One bounded agent pass for the digest**, via the existing workflow+agent pattern (like
   `review_pr_batch_for_learning`): summarize themes, suggest labels, and draft a reply per
   missing-info/new issue. Drafted replies live **in the report**, not on GitHub.
4. **Output**: triage report (`kind: 'issue-triage'`) — sections for new / stale / missing-info
   / dupe candidates, each with the drafted reply and a copy affordance — plus a single `info`
   notification ("Issue triage: 4 new, 7 stale, 2 dupes"). Posting a reply is a human act: v1
   is copy-from-report (or paste into chat for Neon's existing issue-comment action, which is
   already the audited outward path); a one-click "post reply" button is a recorded v1.1 once
   the drafts prove trustworthy.

## Feature 5 — Hygiene (briefing extension + weekly report)

**Fact gatherers** (`src/modules/hygiene/`, all read-only, exec-wrapper precedent):

- **Stale branches**: `git for-each-ref --sort=committerdate refs/heads` per registered repo —
  merged-into-default or no commits > 30 days, excluding default/protected.
- **Worktree cleanup candidates**: existing `cleanupWorktrees` dry-run/policy data.
- **Stalled decisions**: prepared diffs sitting in `revision-requested` / `push-approved` /
  `prepared` beyond 48h; **unused approvals** (`used_at IS NULL`, from CLOSE_DECISION_LOOPS
  PR 3); watches on closed/merged PRs still polling.
- **TODO aging** (weekly only): count + oldest of `TODO|FIXME|HACK` per repo via bounded grep.

**Daily**: `briefingCommand` gains a `hygiene` section (counts + top three items) and the
briefing's `topActions` can now include hygiene actions that map to _existing_ operations only
(worktree cleanup, watch removal, prepared-diff recovery). **Weekly**: a `hygiene` blueprint
(default 604 800) emits the full report (`kind: 'hygiene'`) with per-item detail. Branch
deletion is listed with the exact `git branch -d` commands — never staged, never run, v1.

## Memory & learning integration (applies to every feature above)

Neondeck's learning loop — memory candidates, skill patches with human approval
(`LearningOperatorPanel`), and retrospective reviews (`review_conversation_for_learning`,
`review_pr_batch_for_learning`, `review_kilo_result`) — must be fed by these features, not
bypassed by them. Three commitments, enforced in review of each PR:

1. **Prompts are runtime skills, so the loop can improve them.** Every agent-run prompt
   template in this plan (`neon-pr-review`, `neon-ci-fix`, `neon-docs-fix`,
   `neon-issue-triage`) is seeded at bootstrap into `NEONDECK_HOME/skills/` and referenced by
   id — the location the skill-patch flow is explicitly allowed to modify
   (`src/modules/learning/skill-patches/support.ts:41`). When a retrospective concludes "CI
   fixes keep touching generated files" or "review findings are too pedantic," the correction
   lands as a human-approved skill patch — no code release, no chat lore. Bootstrap re-seeding
   must never clobber a patched skill (seed only when absent; version note in frontmatter).
2. **Runs are minable.** Every Kilo run dispatched here (review pass, ci-fix, docs-fix)
   already flows through the kilo-result review machinery; the workflow summaries added in
   this plan carry the linkage ids (reportId, preparedDiffId, kiloTaskId) so retrospectives
   can correlate _what the agent did_ with _what the human did about it_.
3. **Human corrections become signals.** The high-value, feature-specific outcome facts are
   recorded as learning-visible events (workflow summaries, the existing retrospective input):
   - `/review-pr`: at submit time, how many seeded comments survived vs. were deleted/edited,
     per severity — the direct quality signal for the review skill (the `origin` column makes
     this computable in the existing submit path).
   - `/fix-ci` and revision runs: prepared-diff outcome (approved / revised / abandoned) joined
     to the run — a revise-with-note on an agent fix is exactly the feedback a retrospective
     should mine (the note is already persisted by CLOSE_DECISION_LOOPS).
   - Docs drift / issue triage: report items dismissed vs. acted on (stage-fix clicked, reply
     copied) — the false-positive rate that should tune detection thresholds and the triage
     skill.
4. **Memories flow in, not just out.** The prompt composers include repo-scoped memories
   (existing memory store) so approved knowledge like "this repo's CI flakes on the e2e shard"
   or "reviews here care about error-handling coverage" shapes runs without re-teaching. The
   composer must label memory content as background context, consistent with how recalled
   memories are treated elsewhere.

Nothing new is built for this: it is discipline about _where prompts live_, _what the audit
rows carry_, and _which existing reviewers get pointed at the new sessions_. The only
schema-adjacent work is the outcome-fact fields on the workflow summaries listed above.

## Delivery: five PRs, in order

1. **PR 1 — Reports primitive + `/review-pr`.** Reports table/writer/route/panel; the
   `review-pr-for-human` workflow + command + row button; shared patch-anchor module (moved
   from `review-helpers.ts`, frontend re-imports it); `origin` column migration; seeding with
   anchor validation; `neon-pr-review` runtime-skill seed; seeded-vs-survived outcome facts on
   the submit path; audit rows; safety entries. Tests: report write/serve/prune, structured
   agent-output validation (malformed → no seeding), anchor seeding matrix against the
   captured-real-patch fixture, unanchorable findings stay report-only, existing-human-draft
   guard, origin rendering, HTML escaping of PR-sourced text, outcome-fact recording at
   submit.
2. **PR 2 — `/fix-ci`.** `fix-pr-ci` workflow + command + queue-row button + dossier emission
   (`/explain-ci --report` rides it); `neon-ci-fix` runtime-skill seed; audit rows; safety
   entries. Tests: dossier content from fixture check facts, dispatch single-flight (lock
   contention), no-op run leaves no diff, command parser, skill seed does not clobber a
   patched skill.
3. **PR 3 — Docs drift.** Blueprint kind + executor + detection + report + stage-fix dispatch.
   Tests: watermark advance, detection fixtures (moved path, deleted file, renamed symbol, no
   false hit on unrelated change), silent-when-clean, staged fix produces a prepared diff.
4. **PR 4 — Issue triage.** Issues fetch surface (+ readOnly action/safety) + blueprint +
   classifier + digest workflow + report. Tests: pagination/`since`, PR filtering,
   classification fixtures (stale/missing-info/dupe), report sections, notification counts.
5. **PR 5 — Hygiene.** Fact gatherers + briefing section + weekly blueprint/report. Tests:
   stale-branch fixture repo (real `git init`, precedent exists), stalled-decision queries,
   briefing composition, weekly report content.

PR 1 leads because it validates both platform pieces at once (reports + intake dispatch) and
delivers the headline use case. PRs 2–5 are independent after PR 1; each is separately
shippable and each adds exactly one blueprint kind or command. Verification per PR: `npm run check`, feature vitest suites, and a
manual deck pass (trigger the job/command against a real repo, open the report) recorded in
the PR description.

## Risks

- **Seeded-comment anchor correctness is the `/review-pr` correctness core** — a finding
  seeded onto the wrong line becomes a wrong human-submitted comment two clicks later. The
  shared anchor module + the captured-real-patch fixture matrix (already in the repo from the
  PR-review work) are the guard; anything that fails validation degrades to report-only.
- **Prompt injection via PR content**: `/review-pr` feeds untrusted diff/thread text to the
  agent. Blast radius is bounded — the outputs are HTML-escaped reports and _draft_ comments a
  human edits before anything leaves the deck — but the review prompt must instruct the agent
  to treat PR content as data, and seeded bodies render as plain text, never markdown-executed.
- **Heuristic detection quality** (docs drift, dupe candidates): false positives erode trust in
  reports faster than absence of the feature. Mitigation: reports label confidence, every hit
  shows its evidence lines, and detection thresholds are constants that PR review can argue
  about. Ship weekly-by-default so volume stays reviewable.
- **Kilo run quality on CI fixes**: some failures aren't fixable from logs (infra flakes,
  secrets). The dossier step runs first and stands alone — a failed fix still leaves the human
  better off than today. No-op outcomes must say _why_ (verbatim task conclusion) in the
  notification.
- **Scheduler load**: issue triage and docs drift hit the GitHub API and local git on ticks;
  both are watermarked and per-repo bounded (`limit`, `since`); executors must return `silent`
  outcomes aggressively so the notification stream stays quiet.
- **Report sprawl**: retention constants + one panel; if kinds multiply later, add filtering
  then, not now.
- **Prompt/instruction drift**: the feature prompt templates are runtime skills — changes
  arrive either as reviewable repo diffs (bootstrap seeds) or as human-approved skill patches
  through the learning loop, never as chat lore. A skill-patch regression can be rejected or
  restored through the existing candidate flow.

## Definition of Done

- `/review-pr` (or the row button) on an assigned PR produces the "PR Overview" and "Review
  Issues" reports and seeds anchor-valid draft comments (visually marked as Neon's) into the
  deck's PR review surface; the human prunes/edits, picks the verdict, and submits — Neon
  gains no review-submission path and never overwrites a human's existing draft.
- `/fix-ci` (or the queue-row button) on a red PR produces a CI failure dossier report within
  a minute and, when the failure is fixable, a prepared diff in the normal review loop — with
  the revise loop available on the result. `/explain-ci --report` yields the dossier alone.
- Docs-drift and issue-triage jobs run on their schedules, stay silent when clean, and produce
  evidence-bearing HTML reports openable from the deck; a docs drift hit can be staged into a
  prepared diff with one click; drafted issue replies are one copy away from posting.
- The morning briefing includes hygiene counts with actionable top items; the weekly hygiene
  report enumerates stale branches, cleanup candidates, stalled decisions, and unused
  approvals.
- No new model-callable write capability exists; all outward effects still pass through
  prepared-diff review or explicit human clicks; new routes carry safety entries.
- Every feature's prompt lives as a patchable runtime skill; every agent run is reachable by
  the existing retrospectives; `/review-pr` submit records seeded-vs-survived outcome facts —
  the learning loop can observe and improve all of it without new machinery.
- `npm run verify` passes; each feature's fixture tests run in CI.
