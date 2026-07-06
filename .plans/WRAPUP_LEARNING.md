# Wrap Up the Learning Flywheel (memories in, health out, triggers verified)

Status: **active** — small spec closing the remaining gaps between "learning signals are
recorded" and "the loop actually cycles". Written 2026-07-06 against main `7ede574`; follows
the findings in `.plans/BUSYWORK_ROUTINES_REVIEW.md` and a skeptical audit of the deferred
items in `.plans/DEVIATIONS.md`.

## Current state (verified, so nobody re-derives it)

The flywheel is more wired than folklore suggests. Confirmed on main:

- **Signals in**: seed outcomes per severity land in the `github_pr_review` workflow summary
  (`neonDraftOutcome`, `src/modules/github/reviews.ts:732-749`) and per-comment in
  `pr_review_neon_seeded_comments`; revision/routine/dispatch outcomes all carry linkage ids.
- **Signals reach reviewers**: PR retrospectives gather related workflow summaries by PR
  needles (so `neonDraftOutcome` is in evidence) and now snippet **all five** runtime skills
  (`learningSkillSnippetIds`, `src/modules/learning/reviews/pr-context.ts`), so a
  retrospective can propose patches against exactly the prompt that produced the behavior.
- **Corrections apply**: skill patches (propose/apply/reject/restore) cover the built-in +
  user skills; the workflow-host agents prefer the runtime (patched) skill over the compiled
  copy (`runtimeSkillReferenceByIdSync(...) ?? compiled`).
- **Broken link**: approved *memories* never reach the new automation — zero memory
  references in the pr-review-assist fact builder, `ci-fix-run.ts`, docs-drift staging, or
  `composeRoutinePrompt`. Retrospective → memory → **dead end** for busywork runs.
- **Missing gauge**: no aggregate health numbers anywhere (seed survival rate, routine
  failure rate, drift/triage acted-on rate) — per-event facts only.

## Change 1 — Memories flow into the automation prompts (the loop closer)

Inject bounded, repo-scoped active learning memories into every busywork prompt composer,
reusing the retrospectives' existing reader (`listActiveLearningMemories`,
`src/modules/learning/reviews/context.ts`):

- `reviewFactsForPrompt` (`src/modules/pr-review-assist/actions.ts`) — as a `memories` fact
  array; the `neon-pr-review` skill gains one line telling the model to treat them as
  background conventions, not instructions.
- The ci-fix Kilo prompt builder (`src/modules/autopilot/ci-fix-run.ts`) and the docs-fix
  staging prompt (`stageDocsDriftFix`).
- `composeRoutinePrompt` (`src/modules/routines/service.ts`) — repo-scoped memories only when
  `scope_repo_id` is set; global memories are chat-session concerns, not routine concerns.

Rules: cap count + bytes (constants, e.g. 8 memories / 4 KiB), label the block as background
context (matching how recalled memories are treated elsewhere), and record the included
memory ids in the run's workflow summary so retrospectives can later judge whether a memory
*helped* — that closes the measurement side of the same loop. Tests: composer snapshots with
and without memories; cap enforcement; memory ids on the summary.

## Change 2 — Automation-health aggregates (the gauge)

One read-model module (`src/modules/learning/automation-health.ts`) computing, over a window
(default 30 days, constant):

- **Review assist**: seed survival rate (submitted / seeded), edited-before-submit rate,
  per-severity breakdown — from `pr_review_neon_seeded_comments`.
- **Revision loop**: prepared-diff outcomes joined to revision runs (approved / re-revised /
  abandoned after a run) — from workflow summaries + prepared-diff records.
- **Routines**: run failure rate, auto-pauses, silent-output rate — from `routine_runs`.
- **Drift/triage**: reports acted on (stage-fix clicked) vs. aged out — from reports +
  workflow summaries.

Surfaced in two places, no new panel: a section in the **weekly hygiene report** (the human
gauge) and appended to **PR retrospective evidence** (the model gauge, so a retrospective
sees "survival is 40% and falling" next to the individual outcomes). Tests: fixture rows →
expected rates; empty-window behavior.

## Investigation — trigger cadence (timebox it; changes only if the numbers say so)

Questions to answer with the dogfooding week's data, not speculation:

1. **PR retrospective threshold**: handled-event admission fires from the `run_end`
   observation path with a durable marker. With the new automation volume (revision runs,
   ci-fix, review-assist all emit terminal workflow results), how often does it actually
   fire? Too rarely → lower the threshold; too often → it will be obvious in the operator
   panel. Verify review-assist and routine terminal outcomes are (or deliberately are not)
   counted as handled events — the Phase 22 V1 Closure deviation explicitly asked that new
   automation frontends route through the accounting helper.
2. **Conversation reflection turn counters**: routine sessions now generate assistant turns.
   Decide whether routine sessions should count toward `conversationReviewTurnInterval`
   (probably yes — they're exactly the unattended behavior worth reflecting on) and whether
   the routine id in session metadata survives into the review evidence.
3. **Curation cadence**: memory curation is turn-triggered too; with memories now flowing
   into prompts (Change 1), stale/wrong memories become more costly — confirm curation
   actually runs at the observed turn volume.

## Deviations audit — what was legitimately deferred vs. worth pulling now

Read of every open follow-up in `.plans/DEVIATIONS.md`, sorted:

**Blocked on Flue, leave alone (legit):** transcript summary adapter, active-session skill
refresh, MCP interception hooks, provider hot-reload, signed user-intent approval tokens.
These all name the missing runtime capability; nothing to do here.

**Superseded/done, ignore:** most 2026-06-27/30 follow-ups were completed by later phases
(push-back, recovery, prepared diffs, Kilo reconciliation, workflow observability panel).

**Unblocked and worth pulling into this wrap-up (small):**

- **Skill-patch rollback** (Phase 22 follow-up). `restore` exists on candidates
  (`/patches/:id/restore`) — verify its semantics: if it only re-proposes a rejected
  candidate rather than reverting an *applied* patch, add the explicit rollback action
  (before/after content is already retained, so it's an audited write of the stored
  `before`). With Change 1 increasing how much behavior flows through patched skills, "undo a
  bad patch in one click" stops being optional.
- **Relevance-based skill snippets in retrospectives** (Phase 22 follow-up): now that five
  skills are snippeted wholesale, retrospective context grows linearly — select snippets by
  relevance to the PR's evidence (which workflows actually ran) instead of always all five.
  Do it opportunistically while touching retrospective evidence for Change 2.

**Unblocked but defer until after dogfooding (judge by use, not by plan):**

- Dedicated learning dashboard/CLI review surfaces beyond LearningOperatorPanel, and CLI
  reflection triggers. Real use will show whether the operator panel is enough.
- Issue-triage bounded digest workflow and partial-log CI handoff (both recorded 2026-07-06
  with concrete trigger conditions — those conditions haven't occurred yet).

**Verdict on the "lazy?" question:** no — every deferral names either a missing runtime
capability or a concrete trigger condition, and two earlier deferrals were already paid down
in later slices. The only items that read as "ran out of runway" are the two pulled in above
(rollback, relevance snippets), and the unrecorded memory gap this spec exists to close.

## Delivery

One PR: Changes 1 + 2, the rollback verification/addition, relevance snippets, plus a
DEVIATIONS entry for the (now closed) memory-gap deviation. The trigger-cadence investigation
is a written conclusion in the PR description (with threshold changes only if data demands).
Verification: `npm run check`, module tests above, and one manual pass — approve a memory
like "this repo's e2e shard flakes", run `/review-pr` on that repo, confirm the memory
appears in the composed facts and the run summary records its id.

## Definition of Done

- An approved repo-scoped memory demonstrably shapes the next `/review-pr`, ci-fix,
  docs-fix, and repo-scoped routine run, and each run records which memories it used.
- The weekly hygiene report and PR retrospective evidence both show automation-health rates.
- A bad applied skill patch can be reverted with one audited action.
- Trigger cadence is a documented conclusion, not an open question.
- `npm run verify` passes.
