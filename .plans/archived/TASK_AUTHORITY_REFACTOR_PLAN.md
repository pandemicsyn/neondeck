# Task Authority Refactor Plan

Status: implemented (single-PR)

Related:

- `.plans/ROADMAP.md` Phases 14, 19, 20
- `.plans/REPO_EDITING_PLAN.md`
- `.plans/EXEDEV_WORKSPACE_MODE_PLAN.md`

> The app is not widely used. There is no legacy data or external contract to
> preserve, and breaking changes are acceptable. **This ships as one PR**, not a
> phased rollout. The task list at the end is the build order _within_ that PR.

## Goals

1. **Interactive sessions rarely prompt.** If a human is driving a chat session —
   started from a watched PR or anywhere else — permission prompts are few and far
   between. This is a blanket fact of being interactive. It must not depend on
   keyword detection, request phrasing, or the watch/autopilot state of the linked
   PR.
2. **Autopilot sessions are governed.** When a PR is explicitly put on autopilot,
   restrictions apply. In particular, autopilot can prepare fixes automatically but
   still require review before anything lands.

## The one idea: authority is a function of origin

There is exactly one authority question: **is a human driving this session?**

- **Interactive** — a person is present. Determined solely by that fact, never by
  the PR link, the words used, or an inferred outcome. A watched-PR link supplies
  _context_ (which repo/PR/worktree) and never authority.
- **Autopilot** — work initiated from an event with no human present, governed by a
  per-PR mode.

No `inspect`/`prepare`/`deliver` enum, no verb classification, no additional
origins. Provenance beyond these two (scheduled, delegated, recovery) is at most an
audit label and gets no distinct authority path in this refactor.

## Interactive authority: a fixed capability boundary

Inside a **declared Neondeck repo/worktree boundary**, an interactive session gets a
fixed capability set for free. Defined in code, not per-repo config.

**Free — never prompts (the routine 90%):**

- read/search repo files
- edit repo files (already true: `display-assistant.ts:89`)
- `git add` / `git commit` in the managed worktree
- `git push` to the **linked PR head** (the branch the session is already on)
- run configured repo checks
- post the result comment to the linked PR

**Still prompts — legitimately, and rarely:**

- force-push, or push to any destination other than the linked head
- destructive git (hard reset on shared history, branch delete, history rewrite)
- credential / secret operations
- arbitrary host shell outside the repo capability set
- anything outside the declared repo/worktree boundary
- a diff that trips a shared guardrail (high-risk file, over the file/line limit)

**Never — hardline denies** remain denied for both origins.

"Few prompts" is structural: the routine set is authorized by origin, so the only
prompts are the rare, genuinely consequential ones. There is no language parsing in
this decision. Interactive work is the agent using these capabilities
conversationally — no special workflow, no admission step.

## Autopilot authority: mode is the only mode-consuming path

Autopilot is the only place a mode is consulted. Existing per-PR modes are reused:

| Mode                     | Behavior                                                                       |
| ------------------------ | ------------------------------------------------------------------------------ |
| `notify-only`            | Observe and notify; never touch code.                                          |
| `prepare-only`           | Prepare a diff in a worktree; retain it; never deliver.                        |
| `autofix-with-approval`  | Prepare, commit, verify; **wait for explicit approval before push** (goal #2). |
| `autofix-push-when-safe` | Prepare and deliver automatically when all guardrails pass.                    |

Autopilot runs as the existing bounded watcher workflow, over the **same** repo-edit,
git, worktree, and check services as interactive work. It differs only in the
authority wrapper: no human is present, so it is mode-gated and, on a guardrail hit,
it **stops** (or retains a prepared diff) rather than prompting.

Putting a PR on autopilot stays a separate, explicit action from watching it.

## Shared guardrails, origin-differentiated response

Both origins evaluate the same objective guardrails via a new shared evaluator. Only
the _response_ differs:

- **Interactive** may prompt once for a genuine expansion (new dependency, high-risk
  file, over-limit diff), described by effect, never by command string.
- **Autopilot** cannot expand its own authority: it stops, or under
  `autofix-with-approval` retains the prepared diff and waits.
- **Hardline denies** are denies for both.

---

# Implementation

Everything below lands in one PR. File paths are exact; where a decision is left to
implementation it is called out explicitly.

## 0. Origin detection (the enforcement primitive)

There is **one** `display-assistant` agent, and it exposes every action via its
`actions:` array (`display-assistant.ts:120`). The same agent object is bound to the
autonomous workflows (e.g. `fix-pr-review-feedback.ts` binds `agent: displayAssistant`).
So origin **cannot** be enforced by which tools are on the agent — there is no
separate interactive tool list. It must be detected at runtime and enforced inside
the actions.

The signal already exists. `FlueExecutionContext` carries `runId` **only inside a
workflow run**; direct/interactive agent turns carry `instanceId`/`session` with **no
`runId`** (`@flue/runtime` `run-store-*.d.mts`: "Workflow events may carry `runId`;
direct and dispatched agent events carry `instanceId`… without becoming workflow
runs"). The app already tracks it via `currentFlueExecutionContext()`
(`src/modules/flue/execution-context.ts`). This is the same axis the codebase already
uses for execution `context: 'interactive' | 'unattended'`.

Add one helper:

```ts
// src/modules/flue/origin.ts
export type TaskOrigin = 'interactive' | 'autopilot';
export function currentTaskOrigin(): TaskOrigin {
  return currentFlueExecutionContext()?.runId ? 'autopilot' : 'interactive';
}
```

Enforcement rules that follow from this:

- The new interactive git capabilities (§3) **refuse when origin is `autopilot`** —
  autopilot must go through its prepared-diff/push workflow, never the interactive
  fast path.
- The autopilot fix/prepare/push actions (`neondeck_autopilot_*`) **refuse when origin
  is `interactive`** — this is what structurally guarantees an interactive session can
  never reach the autopilot-policy gate, regardless of what the model tries to call.
- Guardrail _response_ (§1) branches on `currentTaskOrigin()`: interactive → one
  effect-worded confirm; autopilot → stop / prepare per mode.

## 1. Shared guardrails module (`src/modules/repo-guardrails/`)

Extract the objective logic currently inlined in
`src/modules/autopilot-policy/service.ts:32-187` (`checkAutopilotPolicy`) into an
origin-independent evaluator. **Do not** move the mode logic.

```ts
// src/modules/repo-guardrails/index.ts
export type RepoGuardrailViolation = {
  kind:
    | 'denied-path' // hardline for both origins
    | 'high-risk-file' // expansion (interactive prompt / autopilot stop)
    | 'max-files' // expansion
    | 'max-lines' // expansion
    | 'force-push' // expansion unless allowForcePush
    | 'push-destination'; // hardline: only allowedPushDestinations
  path?: string;
  detail: string;
};

export type RepoGuardrailResult = {
  files: FileRiskClassification[];
  diffSummary: {
    files: number;
    lines: number;
    additions: number;
    deletions: number;
  };
  denied: RepoGuardrailViolation[]; // hardline; both origins refuse
  expansions: RepoGuardrailViolation[]; // interactive: one prompt; autopilot: stop
  policyHash: string;
};

export async function evaluateRepoGuardrails(
  input: {
    repoId?: string;
    worktreeId?: string;
    diffBaseRef?: string;
    pushDestination?: string;
    forcePush?: boolean;
    guardrails: RepoGuardrails; // shared config block; see §5
  },
  paths?: RuntimePaths,
): Promise<RepoGuardrailResult>;
```

- Move `classifyFileRisk`, the file/line-limit checks, `pathDeniedByAutopilotPolicy`,
  push-destination and force-push checks here. `classifyFileRisk` and `matchesAny`
  currently live in `src/modules/autopilot-policy/risk.ts` — relocate or re-export.
- Classify each violation as `denied` (hardline) or `expansion` per the table above.
- `checkAutopilotPolicy` is rewritten to: call `evaluateRepoGuardrails`, then apply
  `mode` to produce the existing `AutopilotPolicyDecision` shape (keep `decision`,
  `canPush`, `approvalRequired`, `blocked`, `policyHash`, `mode`, `limits` fields so
  the watcher workflow and `neondeck_autopilot_policy_check` tool are unchanged
  externally). `canPush` stays `mode === 'autofix-push-when-safe' && !denied &&
!expansions`.
- Keep `checkAutopilotConcurrency` and `withAutopilotLocalExecutionSlot` where they
  are; the single-mutation-per-PR lock (`singleMutationPerPr`,
  `service.ts:253-261`) is already origin-agnostic — interactive commits must also
  respect it (see step 4).

## 2. Interactive repo-context resolver (`src/modules/sessions/repo-context.ts`)

The linchpin. Resolves an interactive session to a concrete edit/push target.
Nothing today does this end-to-end.

```ts
export type InteractiveRepoContext = {
  repo: RepoConfig;
  prNumber: number | null;
  worktree: WorktreeRecord; // resolved or created
  pushRemote: string; // origin or fork per maintainerCanModify
  pushBranch: string; // the linked PR head ref
  linkedPrHead: boolean; // true when derived from a linked PR
};

export async function resolveInteractiveRepoContext(
  input: {
    sessionId?: string;
    repoId?: string;
    prNumber?: number;
    worktreeId?: string;
  },
  paths?: RuntimePaths,
): Promise<InteractiveRepoContext | null>;
```

Algorithm:

1. Load the session via `findChatSession` (`src/modules/sessions/store.ts`). Take
   `linkedRepoId` (fall back to `input.repoId`). No repo ⇒ return `null` (interactive
   edits require a declared repo).
2. Derive `prNumber`: prefer `input.prNumber`; else parse `linkedWatchId` of the form
   `owner/name#N` (`agent-context.ts:85` shows this is the encoding). No PR ⇒
   `prNumber = null`; commits still allowed, push becomes an expansion prompt (no
   linked head to target).
3. Resolve the managed worktree by `(repoId, prNumber)`. Reuse the exact
   create/adopt logic from `review-feedback.ts:302-341` (`listWorktrees` /
   `readManagedWorktree` / `createWorktree` with `directPushAllowed =
maintainerCanModify`). Factor that block into a shared `ensurePrWorktree` helper in
   `src/modules/worktrees/` and call it from both places so interactive and autopilot
   resolve worktrees identically.
4. `pushRemote` / `pushBranch`: reuse `remoteForPush` from
   `src/modules/autopilot/push-support.ts` and the PR head ref from the event state.

Note the `linkedTaskId` session field already exists (`agent-context.ts:86`); this
refactor does **not** introduce a durable task domain, so leave it unused/nullable.

## 3. Typed git capabilities (`src/repo-edit/actions.ts`)

Add two actions that operate inside the declared boundary and **never create an
execution-approval record**, mirroring the existing file actions. Both are
**interactive-only**: first line of each `run` is
`if (currentTaskOrigin() === 'autopilot') return failedResult(..., requires:['interactiveOnly'])`.

```ts
export const repoCommitAction = defineAction({
  name: 'neondeck_repo_commit',
  // interactive-only guard first.
  // input: { repoId, worktreeId, message, paths?: string[] }
  // paths omitted ⇒ commit all worktree changes (gitCommitAll)
  // paths present ⇒ gitCommitPaths(worktree.localPath, message, paths)
  // output: GitCommitResult
});

export const repoPushAction = defineAction({
  name: 'neondeck_repo_push',
  // interactive-only guard first.
  // input: { sessionId?, repoId?, worktreeId?, prNumber?, acknowledgeExpansion?: boolean }
  // 1. ctx = resolveInteractiveRepoContext(input); null ⇒ typed error requires:['repoContext']
  // 2. no linked PR head ⇒ ok:false requires:['pushTarget'] (which branch?)
  // 3. g = evaluateRepoGuardrails({ worktreeId: ctx.worktree.id, pushDestination:'pull-request-head', guardrails })
  //    - g.denied.length     ⇒ ok:false requires:['guardrail'] (hardline; do not push)
  //    - g.expansions.length && !acknowledgeExpansion
  //                          ⇒ ok:false requires:['confirmPush'], effect: humanEffectSummary(g.expansions)
  //    - otherwise gitPushHead(ctx.worktree.localPath, { remote: ctx.pushRemote, branch: ctx.pushBranch })
  // output: GitPushResult + guardrail summary
});
```

**Scope-expansion confirm — best-UX, auditable, no new subsystem.** When a push trips
an expansion guardrail, the action returns typed `requires: ['confirmPush']` plus an
effect-worded `effect` string. The agent relays it in natural language; on "yes" it
re-calls `neondeck_repo_push` with `acknowledgeExpansion: true`. This keeps the
confirmation inline in the conversation (no approvalId nudge, no retry reconstruction —
the failure mode that motivated this whole refactor). For audit, **record the decision
as a session audit row** (`recordSessionAudit`, `action: 'repo_push_expansion_ack'`,
with the effect summary and resolved commit SHA) so there is a durable trail without a
parallel approval-record type. `add` and `commit` never gate — push is the single
confirm point.

Register both alongside the existing `neondeck_repo_file_*` actions
(`neondeckRepoEditActions`, `display-assistant.ts:131`). Enforce the boundary with the
repo-registry + `src/repo-edit/path-safety.ts`; `repoPush` refuses any explicit
remote/branch other than the resolved linked head.

## 4. Make interactive and autopilot structurally separate

The separation is enforced by the §0 origin guards, **not** by editing the agent's
tool set (which is shared and would break the autonomous path). Concretely:

- The `neondeck_repo_commit` / `neondeck_repo_push` actions refuse in autopilot origin
  (§3). The `neondeck_autopilot_fix_pr_review_feedback` / `_fix_pr_ci_failure` /
  `_prepare_pr_worktree` / `_push_pr_autofix` actions gain the inverse guard: **refuse
  in interactive origin**, returning `requires:['autopilotWorkflow']`. This is the hard
  guarantee that an interactive session can never reach the autopilot-policy gate.
- After that guard, delete the now-unreachable autopilot-policy consults from the
  interactive story: `repoAutopilotPolicy` / `checkAutopilotPolicy` /
  `pathDeniedByAutopilotPolicy` in `review-feedback.ts:266,480` remain, but only ever
  run under `runId` (autopilot). Interactive edits/commits/pushes use
  `evaluateRepoGuardrails` directly, only at push.
- Rewrite the display-assistant guidance at `display-assistant.ts:75,89` to tell the
  agent: for interactive repo work use `neondeck_repo_file_*` + `neondeck_repo_commit`
  - `neondeck_repo_push`; the `neondeck_autopilot_*` fix actions are workflow-only and
    will refuse in a chat session. The guidance is a hint; the origin guards are the
    enforcement, so a model mistake degrades to a typed error, not a policy prompt.

**Verified during planning** (was previously an open risk): the watcher does not reach
these fix actions through the chat agent's tool choice — the autonomous path runs them
as bound workflow actions / HTTP routes (`autopilot.ts:58`) under a `runId`, so the
interactive-refuse guard does not affect it. A watcher integration test still asserts
this.

**Contention — interactive preempts autopilot (verified feasible).** Interactive
commit/push acquires the shared per-PR worktree lock (`lockWorktree`, scope `pr`).
`worktree_locks` records `owner` and `workflow_run_id` (`locks.ts:24`, auto-recovers
expired locks). If acquisition fails against a live **autopilot-owned** lock (non-null
`workflow_run_id`), the interactive path requests cooperative preemption through the
existing prepared-diff/recovery surface. The autonomous owner checks its mutation lease
between awaited commands and before commit/push/persistence, then releases in its normal
`finally`; the interactive action surfaces `worktreeLock` until retry can acquire the
released lock. This avoids transferring ownership while an already-started Git or
diagnostic subprocess may still be running. An interactive-owned lock is simply waited
on / surfaced. Document this as the rule.

## 5. Config — move objective limits into a shared `guardrails` block

Do the ideal shape now (breaking change, no legacy data to preserve). Split today's
`autopilot` config: objective limits become a top-level `guardrails` block read by both
origins; `autopilot` keeps only initiative concerns.

```json
{
  "guardrails": {
    "deniedFileGlobs": [],
    "approvalRequiredFileGlobs": [],
    "highRiskClasses": [],
    "maxFilesChanged": 50,
    "maxLinesChanged": 1500,
    "allowForcePush": false,
    "allowedPushDestinations": ["pull-request-head"],
    "requiredChecks": []
  },
  "autopilot": {
    "mode": "notify-only",
    "concurrency": { "singleMutationPerPr": true },
    "pushOnApproval": "verify-then-push",
    "watchOverrides": []
  }
}
```

- Move the `AutopilotPolicyLimits` fields out of `appAutopilotSchema` /
  `metadataSchema` (`autopilot-policy/schemas.ts`, `config.ts`) into a new
  `RepoGuardrails` schema; keep per-repo override merging (`mergeAutopilotLimits`
  becomes `mergeGuardrails`).
- `repoAutopilotPolicy` returns `{ mode, concurrency }` only; guardrails are read
  separately by `evaluateRepoGuardrails`.
- There is deliberately **no** `interactive` config block — the interactive capability
  boundary is fixed in code.
- Update `neondeck_config_*` actions and any dashboard config UI that wrote
  `autopilot.limits` to write `guardrails`. This is the one place the "one PR" touches
  config surface; budget for it.

## 6. Deletions (same PR)

- The interactive dependence on execution-approval string matching for git. Routine
  commit/push no longer creates approval records, so the exact-match / shell-operator
  churn in `src/modules/execution/approvals.ts` (`hasShellOperator` at `:274`,
  `match:'exact'` at `:302`) and the "retry with approvalId" nudge at `:236` stop
  occurring on the common path. Leave `neondeck_execution_run` + its approval flow
  intact for genuinely arbitrary host commands.
- Any `inspect`/`prepare`/`deliver` outcome scaffolding — do not build it.

## Task list (build order within the one PR)

1. [x] Add `currentTaskOrigin()` in `src/modules/flue/origin.ts` (§0). Unit-test both
       branches with `runWithFlueExecutionContextForTests`.
2. [x] Split config (§5): new `RepoGuardrails` schema + `guardrails` block; strip
       limits from `autopilot`; update `mergeGuardrails`, `repoAutopilotPolicy`, and
       `neondeck_config_*` write paths. `npm run db:check` if the config parse/validation
       touches persisted shape.
3. [x] Add `src/modules/repo-guardrails/` with `evaluateRepoGuardrails`; move
       `classifyFileRisk` / limit / denied-path / push-dest / force-push out of
       `autopilot-policy`. Unit-test denied-vs-expansion classification.
4. [x] Rewrite `checkAutopilotPolicy` on top of `evaluateRepoGuardrails`, preserving
       its external output shape. Existing autopilot tests pass unchanged (or update for
       the config move only).
5. [x] Factor `ensurePrWorktree` out of `review-feedback.ts` into `worktrees/`.
6. [x] Add `src/modules/sessions/repo-context.ts` with `resolveInteractiveRepoContext`.
       Unit-test PR parsing from `linkedWatchId` and the no-PR path.
7. [x] Add `neondeck_repo_commit` + `neondeck_repo_push` (interactive-only guard,
       `confirmPush` expansion return, session-audit ack). Register in
       `neondeckRepoEditActions`.
8. [x] Add the interactive-refuse guard to the `neondeck_autopilot_*` fix/prepare/push
       actions; rewrite display-assistant guidance (§4).
9. [x] Wire the shared per-PR lock + interactive-preempts-autopilot contention into
       interactive commit/push (§4).
10. [x] Confirm the watcher path is untouched (integration test); remove any code made
        dead by the guards.
11. [x] Tests + docs (below). `npm run check`, `npm run verify`.

## Verification

**Single acceptance gate (must pass to merge):** an integration test where a session
is linked to a PR watched `notify-only`, an explicit "fix this" edits a file, commits,
pushes to the linked head, and comments — asserting **zero** execution-approval
records are created and `notify-only` never blocks the work.

Supporting tests:

- Unit: `currentTaskOrigin()` both branches; `evaluateRepoGuardrails`
  denied-vs-expansion; interactive push refuses non-linked-head destinations;
  `resolveInteractiveRepoContext` PR parsing and no-PR fallback.
- Origin guards: `neondeck_repo_push`/`_commit` refuse under a `runId` context;
  `neondeck_autopilot_fix_pr_review_feedback` refuses with no `runId`.
- Integration: `autofix-with-approval` autopilot prepares but never auto-lands;
  `autofix-push-when-safe` lands only within guardrails; watcher path unchanged.
- Contention: an interactive push preempts a live autopilot-owned PR lock and marks the
  autopilot run for recovery.
- Regression: interactive git creates no `execution_approvals` rows; the `confirmPush`
  path prompts exactly once, proceeds on `acknowledgeExpansion: true`, and writes one
  session-audit ack row.
- `npm run verify` before merge.

Primary metric:

> An explicit interactive fix on a trusted linked PR completes with zero routine
> approvals. An `autofix-with-approval` autopilot task lands only after exactly one
> explicit review approval.

## Non-goals

- No unrestricted shell for interactive sessions; the capability boundary and
  hardline denies still hold.
- Watching a PR is never equivalent to enabling autopilot.
- No keyword/verb detection to determine authority.
- No autonomous task may expand its own authority or bypass hardline denies,
  credential boundaries, or branch permissions.
- No durable task domain, extended origin taxonomy, or outcome enum. Origin is a
  runtime-derived `interactive | autopilot`, not a persisted field.
