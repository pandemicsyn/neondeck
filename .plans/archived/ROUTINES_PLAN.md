# Routines Plan (schedule arbitrary agent tasks with skills, Hermes-style)

Status: **complete / archived** — implementation landed; README and docs now cover routine
records, guardrails, dashboard/API management, delivery modes, and scheduler admission. Original specification for user-defined scheduled agent tasks: a natural-language
prompt + a schedule + a set of runtime skills + a scope, run unattended, delivering into
notifications/reports/sessions. Modeled on Hermes's cron routines (researched at
`~/projects/hermes-agent/cron/`, 2026-07-05) and mapped onto Neondeck's existing scheduler,
skills, sessions, and policy machinery. Written 2026-07-05 against main `77ab999`; builds on
`.plans/BUSYWORK_AUTOMATION_PLAN.md` (reports primitive) and
`.plans/CLOSE_DECISION_LOOPS_PLAN.md` (dispatch discipline).

## Purpose

Today Neondeck's scheduler runs a **closed set** of blueprint kinds (`morning-briefing`,
`watch-pr`, `release-watch`, `review-queue-digest`, plus the busywork plan's additions). Every
new recurring behavior requires a code change: a new picklist value, executor, and PR. Hermes
demonstrates the alternative: a **routine** is data, not code — a prompt ("check my open
reviews and summarize what's blocked"), a schedule, an optional list of skills loaded before
the run, a working scope, and a delivery target. Users (and the agent itself) create them in
natural language; they run unattended; output lands where the user lives.

Neondeck already owns every substrate this needs — a durable job scheduler with a tick loop,
a skills inventory with agent-side loading, sessions, execution policy, reports, and audit.
What's missing is the **routine record**, the **generic executor**, and the **management
surface**. That's this plan.

## What Hermes does (research summary, for the record)

From `cron/jobs.py` / `cron/scheduler.py`:

- A job is JSON: `prompt`, `schedule` (cron expression / interval / one-shot), `name`,
  `repeat` (N times or forever), `deliver` (origin platform / local / telegram / ...),
  `skills[]` (loaded before the run), per-job `model`/`provider` overrides, `script` (stdout
  injected as prompt context — the data-collection pattern — or, with `no_agent`, the script
  _is_ the job), `context_from` (inject prior output of other jobs — chaining),
  `enabled_toolsets` (restrict the tool surface per job), `workdir` (context files + tool cwd).
- A 60s ticker with heartbeat/last-success files (liveness vs. health distinguished),
  cross-process file locking on the job store, per-run markdown output under
  `cron/output/<job>/<timestamp>.md`, one-shot grace windows.
- Jobs are created conversationally by the agent or via CLI; per-profile isolation.

What we adopt: the job-as-data model, skills-per-job, scoped cwd, delivery targets, per-run
output history, run-now/pause/once semantics, agent-creatable with guardrails. What we skip
(v1): scripts/no-agent mode (Neondeck's execution policy + deterministic watches cover the
watchdog pattern), per-job model overrides (config-level concern), context-chaining (recorded
as v2 — Hermes proves it's useful, but it needs the output store to exist first).

## Ground Rules (verified against main `77ab999`, 2026-07-05)

- **Scheduler**: durable `JobRecord`s with `type`/`config`/`lastResult`, executed by
  `executeJob` dispatch on ticks (`src/modules/scheduler/dispatch.ts:20`); blueprint kinds are
  a typed picklist (`schemas.ts:26,78`); executors invoke workflows via
  `invoke(module.default, { input })`.
- **Skills**: built-in skills compile into the agent (`import ... with { type: 'skill' }`,
  `src/agents/display-assistant.ts:41`); **runtime skills** live under `NEONDECK_HOME/skills`
  (`runtime-home/paths.ts:59`) with an inventory (`listRuntimeSkills`,
  `src/modules/runtime/skills.ts`), agent-side lookup/load actions
  (`neondeck_runtime_skills_lookup`, `neondeck_runtime_skill_load`), reload, and — crucially —
  the **learning loop can patch them** (`skill_patch_apply` restricted to the built-in
  `neondeck` skill and user skills under `NEONDECK_HOME/skills`,
  `src/modules/learning/skill-patches/support.ts:41`).
- **Agent execution substrates**: (a) Flue workflows wrap actions with the display assistant
  (`defineWorkflow({ agent, action })` / `{ agent, input, run }`); (b) sessions with durable
  command events (`createChatSession`, `createChatSessionCommandEvent`, #69); (c) Kilo
  background tasks (`startKiloTask({ prompt, worktreeId })`) with persisted state and
  deck-rendered diffs; (d) session start is the documented way to load "changed SOUL, skills,
  memory, and model config into prompt context" (`display-assistant.ts:82`).
- **Policy + trust**: commands run through execution policy (preapproval/approval flow);
  outward mutations (push, PR comment) are gated actions with audit; watches prove the
  precedent that **Neon may create durable scheduled records via actions**
  (`neondeck_watch_pr_add` is model-callable, safeMutation + audit).
- **Reports primitive** (from BUSYWORK plan PR 1): `writeReport(...)` + serving route + panel —
  routines' per-run output history rides it.

## Non-Goals

- **No arbitrary-code jobs** (Hermes `script`/`no_agent`). Command execution stays inside the
  agent turn under execution policy. A "run this shell command nightly" want is a routine
  whose prompt says so — and whose commands hit the same preapproval wall as everything else.
- **No per-routine model/provider overrides** in v1.
- **No context-chaining between routines** in v1 (recorded v2: inject `lastReport` of another
  routine by id, once output history exists).
- **No new trust surface.** A routine cannot do anything the display assistant can't already
  do in a chat turn. Approval-gated actions stay approval-gated when a routine triggers them —
  an unattended run that hits an approval wall records the pending approval and moves on
  (which the CLOSE_DECISION_LOOPS nudge then surfaces).
- **Not replacing typed blueprints.** Watches and the busywork jobs stay typed executors —
  deterministic fact-gathering should not pay agent-turn costs. Routines are for the long tail.

## Design

### Routine record

New table `routines` (Drizzle, `db:generate`):

```text
routines
  id            TEXT PK
  name          TEXT NOT NULL
  prompt        TEXT NOT NULL              -- self-contained task instruction
  schedule_kind TEXT NOT NULL              -- 'cron' | 'interval' | 'once'
  schedule      TEXT NOT NULL              -- cron expr / seconds / ISO timestamp
  skills        TEXT                       -- JSON array of runtime-skill ids
  scope_repo_id TEXT                       -- optional repo scope
  scope_cwd     TEXT                       -- optional working directory (validated real path)
  delivery      TEXT NOT NULL              -- 'notification' | 'report' | 'session'
  session_id    TEXT                       -- target session when delivery = 'session'
  repeat_limit  INTEGER                    -- NULL = forever; 1 = one-shot
  run_count     INTEGER NOT NULL DEFAULT 0
  enabled       INTEGER NOT NULL DEFAULT 1
  created_by    TEXT NOT NULL              -- 'user:<surface>' | 'agent:<sessionId>'
  created_at / updated_at / last_run_at / next_run_at TEXT
```

Schedule parsing follows the scheduler's existing interval conventions plus cron expressions
(add a small cron parser dep or port the interval math; Hermes uses croniter — pick one exact
pin). `next_run_at` is materialized on write so the tick query is an index scan.

### Executor

One new blueprint kind `routine-tick` is **not** added per routine; instead the scheduler
gains a single generic step: on each tick, select due enabled routines
(`next_run_at <= now`), and for each, dispatch the `run-routine` workflow with
`{ routineId }`, then advance `next_run_at`/`run_count` (one-shots disable themselves;
`repeat_limit` reached → disabled). Concurrency: a routine that is still running is skipped,
not queued (per-routine single-flight via a `running_run_id` column check); global cap of
N=2 concurrent routine runs, constant.

### Run substrate (the one open design decision — resolve at implementation start)

The routine run must be a real agent turn with the routine's skills in context. Three
candidate substrates, in preference order; **verify (a) against the Flue runtime API first**,
fall back down the list:

1. **(a) Prompt-goal workflow**: `defineWorkflow({ agent: displayAssistant, input, run })`
   where the run drives an agent turn on the routine prompt (the way chat turns run, headless).
   If `@flue/runtime` exposes this (agent invocation with a message/goal rather than a
   deterministic action), it is the cleanest: one workflow, runs recorded like all others.
2. **(b) Session-based**: create (or reuse) a dedicated session per routine
   (`surface: 'routine'`, named after it), post the composed prompt as a durable command
   event, and have the gateway run the turn — this is how the deck already delivers work to
   sessions, and session start is the documented skill/memory loading path.
3. **(c) Kilo** for repo-scoped routines (`scope_repo_id` set): `startKiloTask` with the
   composed prompt against the repo path — already proven, but wrong for non-repo routines
   (no worktree to scope to).

Whichever substrate wins, the **composed prompt** is deterministic and testable: routine
prompt + loaded skill bodies (resolved via `listRuntimeSkills`, invalid/inactive ids fail the
run with a clear error rather than silently omitting guidance) + scope context (repo status
facts when `scope_repo_id` is set) + delivery instructions + standing bounds (_you are running
unattended; do not wait for user input; approval-gated actions will queue approvals, note them
in your output and continue_).

### Delivery

- `notification` (default): one notification per run with the summary line; `silent` outcome
  suppression when the routine reports "nothing to do" (the prompt contract asks the agent to
  say so explicitly — matching the scheduler's silent-refresh house rule).
- `report`: every run writes a report (`kind: 'routine'`, `sourceRef: routineId`) — the
  per-run output history, Hermes's `cron/output/` equivalent; notification only on non-silent
  outcomes.
- `session`: post the run summary into the linked session as a command event (the
  conversational delivery — "tell me in our chat").

All runs additionally write a compact run row into the routine's history (workflow summaries,
keyed `routine:<id>`), so the management panel can show last-N outcomes without opening
reports.

### Creation and management

- **Deck**: a Routines panel (list: name, schedule, last outcome, next run; actions: run now,
  pause/resume, edit prompt/schedule/skills, delete with confirm; create form with a skill
  picker fed by the runtime-skills inventory). Routes are user-surface CRUD
  (`/api/routines...`), safeMutation + audit.
- **Chat**: a model-callable `neondeck_routine_create` / `_update` / `_list` / `_delete`
  action set — this is the Hermes-style "just tell the agent" path, and it follows the
  `neondeck_watch_pr_add` precedent (agent-creatable durable schedule records, safeMutation,
  audit rows). Guardrails: agent-created routines record `created_by: agent:<sessionId>`, cap
  agent-created enabled routines (constant, e.g. 10), minimum interval 15 minutes, and the
  creation notification always fires so a routine can never appear silently.
- **Kill switch**: a single `routines.enabled` config flag pauses the whole subsystem
  (mirrors the ticker-liveness lesson from Hermes: the panel shows last tick time so a dead
  ticker is visible, not silently healthy).

### Learning-loop integration (mirrors Hermes's self-improvement loop)

- Routine skills are **runtime skills**, so the existing skill-patch loop already covers
  improvement: a retrospective that concludes "the nightly triage routine keeps missing X"
  produces a skill-patch candidate against the routine's skill, human-approved via the
  existing LearningOperatorPanel flow. No new machinery — this is why routines reference
  skills by id instead of embedding instruction text.
- Routine run sessions/trajectories are eligible for the existing conversation-learning
  review (`review_conversation_for_learning`), same as chat sessions; the routine id rides
  the session metadata so retrospectives can group by routine.
- Repeated per-run failures (N consecutive `failed` outcomes, constant) auto-pause the
  routine with an `attention` notification — don't let a broken routine burn turns nightly.

## Delivery: two PRs

1. **PR 1 — Core**: `routines` table + schedule math + scheduler tick integration +
   `run-routine` workflow on the chosen substrate (spike (a) first; decision recorded in the
   PR description) + composed-prompt builder + delivery (notification + report) + run history
   - deck panel (list/create/run-now/pause/delete) + safety entries. Tests: schedule
     materialization (cron/interval/once/repeat/one-shot self-disable), due-selection +
     single-flight + global cap, skill resolution failure, composed-prompt snapshot, silent
     outcome suppression, auto-pause after consecutive failures.
2. **PR 2 — Conversational + session delivery**: `neondeck_routine_*` actions with the
   agent-creation guardrails + `session` delivery + panel edit flows. Tests: agent-created
   caps/minimum interval, created_by audit, session command-event delivery, kill switch.

Verification: `npm run check`; manual pass — create "every weekday at 9am, list my PRs
waiting on review and what's blocked, deliver as report" from chat, watch it run now, open
the report, pause it.

## Risks

- **The substrate decision is load-bearing.** If Flue lacks prompt-goal workflow runs, the
  session-based path (b) must be validated for headless turn execution before PR 1 lands —
  spike this in the first two days; everything else in the plan is substrate-independent.
- **Unattended prompts hitting approval gates**: the standing bounds text tells the agent to
  queue-and-continue; the CLOSE_DECISION_LOOPS nudge work makes those queued approvals
  visible. Without that plan landed, routines that need approvals will feel stuck — sequence
  accordingly.
- **Cost/runaway control**: caps (global concurrency, agent-created count, min interval,
  auto-pause) are all constants in v1 — deliberately not configurable until real usage says
  which knob matters.
- **Prompt injection via skill content**: routine skills are human-approved files under
  `NEONDECK_HOME/skills` (and patches to them are human-approved) — the trust chain is the
  existing skills trust chain, unchanged.
- **Scheduler tick budget**: routine dispatch is fire-and-record; the tick must never await an
  agent turn. The existing watch-refresh tick pattern is the model.

## Definition of Done

- "Neon, every morning at 9 summarize my review queue and what's blocked, as a report" —
  spoken in chat — creates a visible, audited routine that runs unattended, loads its skills,
  writes a report per run, notifies on non-silent outcomes, and can be paused/edited/deleted
  from the deck.
- A routine scoped to a repo can operate on that repo under execution policy; anything
  approval-gated queues an approval and says so in its output instead of hanging.
- Routine skills are improvable through the existing skill-patch learning loop without
  touching routine records; routine sessions are minable by the existing retrospectives.
- Broken routines pause themselves loudly; a dead ticker is visible on the panel; the kill
  switch stops everything.
- No new model-callable capability beyond routine CRUD (watch-precedent, capped, audited);
  `npm run verify` passes.
