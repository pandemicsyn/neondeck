# Static Review: Busywork Automation + Routines + Close-Loops Follow-ups

Status: **resolved (one plan gap, minor notes)** — static review (no tests executed) of the
implementations of `.plans/BUSYWORK_AUTOMATION_PLAN.md` and `.plans/ROUTINES_PLAN.md`, plus the
close-loops follow-up fixes, commits `9e1bf1b..7ede574` on main (26 commits, ~53k lines).
Reviewed 2026-07-06.

## Coverage statement

Deep-read: routines service admission/settlement/guardrails, pr-review-assist service +
action + workflow + agent, ci-fix entry/gating, reports service/routes/HTML template,
trust wiring (agents, action registration, command denylist, safety entries), scheduler
integration, bootstrap skill seeding, seeded-outcome recording in `github/reviews.ts`.
Skimmed (structure + entry points + boundary checks, not line-by-line): detection internals of
docs-drift (817 lines) / issue-triage (383) / hygiene (410), the middle of `ci-fix-run.ts`
(1313 lines, but with 1267 lines of dedicated tests and eight hardening commits behind it),
and `RoutinesPanel.tsx` (734 lines of UI). ~5,700 lines of new tests accompany the change,
including 1,251 for routines and 1,267 for ci-fix.

## Verdict

Plan-faithful and consistently hardened beyond spec. The previous review's three findings were
fixed first (`9e1bf1b`, `392cb04`, `93f1440`). Trust boundaries are enforced **in code**, not
just agent instructions. One genuine plan gap (memories into prompts) and a handful of notes.

What stands out:

- **Zero-capability workflow-host agents.** The plans said "no new agents"; the implementation
  added three (`pr-review-assistant`, `busywork-workflow`, `scheduler-workflow`) — but each has
  `tools: [], actions: [], subagents: []` and exists only to give bounded workflows an LLM +
  the patchable runtime skill (`runtimeSkillReferenceByIdSync(...) ?? compiled`). This is a
  _stronger_ posture than reusing the display assistant, which would have carried its full
  action surface into unattended runs. Good deviation — but see note 3.
- **`/fix-ci` is hard-denylisted for Neon** (`modelCallableCommandDenylist`,
  `src/modules/commands/actions.ts:37`) with a typed refusal — not instruction-only. Both the
  Fix CI and "neon review" dashboard buttons invoke workflows directly (human admission).
- **The Flue prompt-goal substrate exists and was used**: the review pass runs via
  `harness.session().skill('neon-pr-review', { args, result: schema, signal: timeout })` —
  structured output validated at the harness _and_ re-validated in the service; malformed
  output fails the run without seeding, exactly per plan.
- **Seeding guards all present**: `draftHasHumanWork` + existing-draft-comments skip,
  `commentAnchorExists` via the shared `shared/patch-anchors.ts` module (frontend re-imports
  it), `origin: 'neon'`, unanchorable findings degrade to report-only, and there is a
  dedicated `pr_review_neon_seeded_comments` table.
- **Learning outcome facts exceed the plan**: submit computes a per-severity matrix
  (seeded/submitted/skipped/deleted/edited-submitted) and stamps per-comment outcomes.
- **Routines are the plan plus more**: session-substrate (durable command event + live
  `dispatch`), 15-minute minimum interval enforced even for cron expressions via gap analysis,
  agent-created cap (10) enforced on create _and_ resume, unspoofable `created_by` (session id
  from the AsyncLocalStorage Flue context, not model input), per-routine single-flight +
  global concurrency cap + stale-claim recovery, transactional idempotent settlement with
  auto-pause after consecutive failures and repeat-limit self-disable, kill switch, ticker
  state recording, and command events settled on completion (no double-run path exists —
  pending command events are records, not an execution queue).
- **Reports**: id-indirected file serving (no user-supplied paths), strict CSP
  (`default-src 'none'`) + nosniff on served HTML, all-template escaping via `escapeHtml`,
  retention with `preserveIds`, bootstrap skill seeding is copy-if-missing (no clobber of
  patched skills).
- **Scheduled jobs**: blueprint kinds registered end-to-end; hygiene lists
  `git branch -d` as suggested text and never runs it; issue triage has no outward mutation
  path (v1 deterministic drafts, recorded in DEVIATIONS.md); docs-drift fix runs record a
  per-task allowed-paths boundary validated at Kilo reconcile before promotion.

## Findings

### 1. [gap] "Memories flow in" (BUSYWORK learning commitment 4) is not implemented

Zero memory references exist in the pr-review-assist fact/prompt builders, `ci-fix-run.ts`,
the docs-drift service, `composeRoutinePrompt`, or any of the four seeded skills. The other
three learning commitments landed in full (patchable runtime skills with agent-side override,
linkage ids on every workflow summary, the seeded-vs-survived outcome matrix) — this one
didn't, and it is not recorded in `.plans/DEVIATIONS.md` either. Either implement (inject
repo-scoped memories into the prompt composers, labeled as background context) or record the
deferral as a deviation so the plan doesn't silently read as done.

### 2. [smell, carried] `process.env.NEONDECK_HOME` mutation now lives in two places

`create-app.ts:67` sets it at startup (good — that anchors the invariant), but the
per-dispatch mutation in `autopilot-push-dispatch.ts:196` survives and is now mostly
redundant. Consolidate on the startup assignment or comment why the dispatch path must
re-assert it.

### 3. [note] Record the workflow-host-agent deviation

DEVIATIONS.md got entries for the fix-ci truncation stop and deterministic issue-triage
drafts, but not for "three new zero-capability agents despite 'no new agents' in both plans."
It's the right call — write it down so a future reader doesn't "simplify" the workflow hosts
back onto the display assistant.

### 4. [note] Docs-drift path boundary is post-hoc, not preventive

The Kilo docs-fix run is not sandboxed to docs paths during execution; violations are caught
by `validateDocsDriftFixTaskDiff` at reconcile (`kilo/results/service.ts:66`) before anything
is promoted. Given the result cannot escape prepared-diff review regardless, this is
acceptable defense-in-depth — noting it so the enforcement point is known.

### 5. [note] Issue-triage agent digest deferral

Recorded in DEVIATIONS.md and reasonable (deterministic drafts v1). When the bounded digest
workflow arrives, it should follow the `harness.session().skill()` pattern proven by the
review pass rather than nesting workflow dispatch inside the scheduler job — the deviation
entry already says as much.

## Suggested follow-up

Finding 1 is the only real work: one prompt-composer change per feature plus a DEVIATIONS
entry if deferred. Findings 2–3 are a comment/log-line and a paragraph of documentation.
