# Neondeck Self-Improvement And Learning Implementation Plan

## Goal

Build a Hermes-inspired self-improvement system for Neondeck in one cohesive implementation. Neon should learn durable user preferences, local/tooling lessons, and project conventions; patch procedural skills when future behavior should change; and periodically review its own PR/autopilot work for recurring mistakes.

This is not a replacement for Flue chat history, session summaries, watch state, or workflow summaries. Learning should convert repeated or high-signal evidence into durable memory and skill improvements that shape future sessions.

## Product Behavior

Neondeck should learn through two main paths:

1. Conversation reflection:
   - After a configurable number of user turns, default 10, run a bounded background self-improvement review.
   - The review inspects recent conversation/session evidence and decides whether to write memory, patch a skill, or do nothing.
   - The active display-assistant prompt does not change mid-session. New memory and skill changes apply to new sessions or explicit refresh flows.

2. PR/autopilot retrospective:
   - After every configurable batch of handled PRs, default 5, run a bounded retrospective.
   - The retrospective inspects workflow summaries, prepared diffs, verification failures, review feedback, notifications, and final PR outcomes.
   - It should identify repeated mistakes such as recurring linter errors, missed repo conventions, bad verification order, or review-feedback patterns.
   - Durable lessons become `project` or `local` memory and/or Neondeck skill patches.

Learning should be visible and auditable:

- Show what was learned.
- Show why it was learned.
- Show whether it changed memory, skills, or both.
- Allow archive/reject/rollback of learning artifacts.

## Memory Model

Use three active memory scopes:

- `user`: durable preferences and expectations about the user.
- `local`: machine, tool, environment, CLI, provider, and workflow facts that are not tied to one repo.
- `project`: repo/product/team-specific conventions and failure patterns.

Do not use new `session` or `watch` memories for learning.

- Session state belongs in Flue transcript plus Neondeck session summaries/metadata.
- Watch state belongs in `pr_watches`, `ref_watches`, watch watermarks, workflow summaries, and notifications.
- Existing `session` and `watch` memory rows can remain readable for compatibility, but new memory writes should reject or warn on those scopes unless a migration command explicitly handles old data.

Memory should store durable knowledge, not operational bookkeeping.

Examples:

- `user/style.concise-engineering`: User prefers direct, concrete engineering answers.
- `local/github.review-threads`: Use GitHub reviewThreads before concluding PR feedback is addressed.
- `project/neondeck.valibot-boundaries`: Neondeck uses Valibot at API/action IO boundaries; do not introduce Zod.
- `project/neondeck.fast-check`: Use `npm run check` for the fast development loop; use `npm run verify` for the full gate.

## Runtime Configuration

Extend runtime-home `config.json` with a `learning` object:

```json
{
  "learning": {
    "enabled": true,
    "memoryWriteMode": "auto",
    "skillWriteMode": "auto",
    "memoryCurationEnabled": true,
    "memoryCurationMode": "review",
    "conversationReviewTurnInterval": 10,
    "memoryCurationTurnInterval": 200,
    "prRetrospectiveThreshold": 5,
    "notifications": "on",
    "memoryMaxActiveItems": 200,
    "maxRecentTurns": 30,
    "maxPrBatchItems": 8
  },
  "models": {
    "selfImprovement": "kilocode/kilo-auto/fast",
    "selfImprovementThinkingLevel": "low"
  }
}
```

Learning write modes:

- `auto`: apply low-risk learning changes immediately and record audit evidence.
- `review`: create candidates/proposals that require explicit approval.
- `off`: do not create or apply this class of learning change.

Memory curation modes:

- `off`: never run memory curation automatically.
- `review`: propose memory rewrites, merges, and archives for approval.
- `auto`: allow the learning agent to curate memory directly through typed actions and audit events.

Manual curation commands should work even when automatic curation is disabled.

Model selection:

- Add `models.selfImprovement` and `models.selfImprovementThinkingLevel`.
- Add env fallbacks:
  - `FLUE_SELF_IMPROVEMENT_MODEL`
  - `FLUE_SELF_IMPROVEMENT_THINKING_LEVEL`
- Resolve the learning model in this order:
  1. `models.selfImprovement`
  2. `FLUE_SELF_IMPROVEMENT_MODEL`
  3. `models.utility`
  4. `FLUE_UTILITY_MODEL`
  5. `models.displayAssistant`
  6. `FLUE_AGENT_MODEL`
  7. existing default agent model
- Resolve learning reasoning in this order:
  1. `models.selfImprovementThinkingLevel`
  2. `FLUE_SELF_IMPROVEMENT_THINKING_LEVEL`
  3. `models.utilityThinkingLevel`
  4. `FLUE_UTILITY_THINKING_LEVEL`
  5. `low`

Default behavior should work without extra setup. If no explicit self-improvement model is configured, use the utility model if present, otherwise fall back to the display assistant. The first-run wizard and docs should recommend a cheap fast model for reflection, but not require one.

## Database Changes

Update the Neondeck app SQLite schema.

### Simple Memory Table Upgrade

Keep memory closer to Hermes: a small current working set of guidance, not an evidence graph. SQLite should provide durability, indexing, audit, and UI visibility without making every memory a forensic record.

Extend or normalize `memories` toward:

- `id TEXT PRIMARY KEY`
- `scope TEXT NOT NULL`
- `key TEXT NOT NULL`
- `value_json TEXT NOT NULL`
- `repo_id TEXT`
- `status TEXT NOT NULL DEFAULT 'active'`
- `use_count INTEGER NOT NULL DEFAULT 0`
- `last_used_at TEXT`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

Supported `scope` values for new writes:

- `user`
- `local`
- `project`

Supported `status` values:

- `active`
- `archived`

Keep unique identity simple. Prefer `UNIQUE(scope, key)` for v1 and make rewrites explicit. If a project memory needs repo-specific identity, include repo id in the key or keep `repo_id` nullable and enforce uniqueness in service code.

The learning agent should have free rein to update, rewrite, merge, and archive memory through typed actions. If a user correction contradicts an old memory, the correct behavior is to replace or archive the old guidance and write the new current guidance.

### Memory Events

Add `memory_events` as the rollback/audit trail:

- `id TEXT PRIMARY KEY`
- `memory_id TEXT`
- `action TEXT NOT NULL`
- `actor TEXT NOT NULL`
- `reason TEXT`
- `before_json TEXT`
- `after_json TEXT`
- `created_at TEXT NOT NULL`

Actions:

- `created`
- `updated`
- `rewritten`
- `merged`
- `archived`
- `rejected`

Actors:

- `user`
- `neon`
- `workflow`

Do not store rejected prompt-injection-like content as an active memory. Record a `memory_events` rejection with a bounded reason instead.

### Learning Events

Add `learning_events`:

- `id TEXT PRIMARY KEY`
- `type TEXT NOT NULL`
- `source TEXT NOT NULL`
- `source_id TEXT`
- `repo_id TEXT`
- `session_id TEXT`
- `pr_key TEXT`
- `data_json TEXT`
- `created_at TEXT NOT NULL`

Event types:

- `conversation_turn`
- `memory_candidate_created`
- `memory_applied`
- `memory_rejected`
- `memory_archived`
- `memory_curated`
- `skill_patch_proposed`
- `skill_patch_applied`
- `pr_handled`
- `reflection_started`
- `reflection_completed`
- `reflection_failed`

### Learning Reviews

Add `learning_reviews`:

- `id TEXT PRIMARY KEY`
- `kind TEXT NOT NULL`
- `status TEXT NOT NULL`
- `model TEXT NOT NULL`
- `thinking_level TEXT NOT NULL`
- `trigger_json TEXT NOT NULL`
- `input_summary_json TEXT`
- `result_json TEXT`
- `error TEXT`
- `started_at TEXT NOT NULL`
- `completed_at TEXT`

Review kinds:

- `conversation`
- `pr-batch`
- `manual`
- `curation`

### Learning Candidates

Add `learning_candidates`:

- `id TEXT PRIMARY KEY`
- `target TEXT NOT NULL`
- `status TEXT NOT NULL`
- `scope TEXT`
- `key TEXT`
- `value_json TEXT`
- `skill_id TEXT`
- `patch_json TEXT`
- `repo_id TEXT`
- `reason TEXT`
- `review_id TEXT`
- `created_at TEXT NOT NULL`
- `decided_at TEXT`

Targets:

- `memory`
- `skill`

Statuses:

- `proposed`
- `applied`
- `rejected`
- `archived`

Use candidates only when policy is `review` or when the workflow intentionally wants user inspection. In `auto` mode, the workflow can mutate memory directly through typed actions and rely on `memory_events` for audit/rollback.

### PR Learning Cursor

Add enough state to know when to trigger PR retrospectives:

- Either a table `learning_pr_cursors`
- Or `learning_events` queries over `type='pr_handled'`

The cursor should support:

- global PR handled count since last review
- per-repo PR handled count since last review
- last review id and timestamp
- idempotency so the same PR outcome is not counted multiple times

Prefer event-query plus idempotency key first. Add a dedicated cursor table only if queries become awkward.

## Flue Architecture

Use Flue primitives intentionally:

- Agent:
  - Keep `display-assistant` as the user-facing session agent.
  - Add a dedicated non-user-facing reflection agent or subagent role if Flue's current APIs make that cleaner than overloading the display assistant.

- Workflows:
  - `review_conversation_for_learning`
  - `review_pr_batch_for_learning`
  - `curate_learning_store`

- Actions:
  - deterministic storage, policy, config, and skill patch actions.

- Skills:
  - update the Neondeck skill with learning guidance.
  - learning should patch skills for procedural knowledge, not only write memories.

Do not keep long-running Flue workflows open. The app scheduler/session hooks should decide when to start bounded reflection workflows.

## Model Wiring

Add self-improvement model support to `src/agent-config.ts` and runtime config schemas:

- `selfImprovement`
- `selfImprovementThinkingLevel`
- `selfImprovementConfigured`

Expose these in runtime status and config actions:

- `neondeck_config_update_agent_models` should accept `selfImprovement` and `selfImprovementThinkingLevel`.
- `/reasoning` should remain display-assistant focused unless explicitly extended later.
- Add docs that reflection model settings are for background learning and PR retrospectives.

If Flue subagents support per-subagent model and thinking levels, define a `learningReviewer` or `reflectionReviewer` subagent. Otherwise, define a small dedicated reflection agent module with the resolved model.

The reflection agent/subagent should have narrow instructions:

- inspect only supplied summaries/evidence
- propose or apply learning via typed learning actions
- do not run shell/GitHub/repo mutation/Kilo/autopilot actions
- do not create broad negative beliefs from transient failures
- prefer skill patches for repeatable procedure changes
- prefer memory for durable facts and preferences

## Learning Actions

Add schema-backed actions using Valibot at all IO boundaries.

### Memory Actions

Add:

- `neondeck_memory_learn`
- `neondeck_memory_rewrite`
- `neondeck_memory_merge`
- `neondeck_memory_archive`
- `neondeck_memory_candidate_create`
- `neondeck_memory_candidate_list`
- `neondeck_memory_candidate_decide`
- `neondeck_memory_mark_used`

`neondeck_memory_learn` should:

- accept `scope`, `key`, `value`, optional `repoId`, and optional `reason`
- validate active scopes: `user | local | project`
- reject secrets and prompt-injection-like content before writing active memory
- upsert by scope/key
- write memory event audit rows with before/after snapshots
- return a compact result, not full memory blobs
- mark active sessions stale when active memory changes

The learning agent should use these actions as its maintenance surface. It can rewrite old guidance, merge duplicates, archive stale entries, and add new entries without direct file/database edits. The guardrail is typed mutation plus audit history, not a timid learning agent.

### Skill Learning Actions

Add:

- `neondeck_learning_skill_patch_propose`
- `neondeck_learning_skill_patch_apply`
- `neondeck_learning_skill_patch_reject`
- `neondeck_learning_skill_patch_list`
- `neondeck_learning_skill_patch_restore`

Initial support can be restricted to Neondeck-owned runtime skills:

- built-in Neondeck skill under `src/skills/neondeck/SKILL.md`
- user skills under `NEONDECK_HOME/skills`
- in-repo `.codex/skills` only when an explicit dev config flag is enabled

Skill patches should:

- be diff-based
- preserve frontmatter and existing sections
- write audit rows
- avoid patching bundled third-party skills unless explicitly allowed
- create a backup or record enough diff data to rollback
- restore applied patches only through the audit-backed restore action when the target file still matches the applied patch hash

Do not create new skills automatically in the first implementation unless the user explicitly invokes learning for a new skill. Prefer patching existing skills or creating candidates.

### Learning Review Actions

Add:

- `neondeck_learning_event_record`
- `neondeck_learning_review_start`
- `neondeck_learning_review_complete`
- `neondeck_learning_review_status`
- `neondeck_learning_review_list`

These should be deterministic app-state actions used by workflows and dashboard/API surfaces.

## Conversation Reflection Workflow

Create `review_conversation_for_learning`.

Trigger:

- After every `learning.conversationReviewTurnInterval` user turns for active display-assistant sessions.
- Manual command: `/learning review` or CLI equivalent.

Inputs:

- `sessionId`
- recent bounded session summary
- recent message excerpts if available through supported session APIs
- recently used tools/actions/workflows
- explicit user corrections if detectable
- currently loaded memory ids
- current active skills index
- learning config/policy

Output:

- list of memory writes, rewrites, merges, archives, or candidates depending on policy
- list of skill patch candidates/applied patches
- skipped reasons
- review summary

Rules:

- It runs after the user-facing response is complete.
- It should not block the chat response.
- It should not mutate the active display-assistant prompt.
- It should not perform host execution, GitHub mutation, repo edits, Kilo delegation, or watch/autopilot work.
- It should be best-effort; failures become learning review records and optionally notifications.

Conversation review prompt should follow Hermes' strongest rules:

- user corrections are high-signal
- reusable workflow corrections belong in skills
- durable user preferences can go to memory
- tool/setup failures should learn the fix, not "tool is broken"
- do not save one-off task narratives
- do not save obvious facts or things easily rediscovered
- do not create persistent self-imposed constraints from transient failures

## PR/Autopilot Retrospective Workflow

Create `review_pr_batch_for_learning`.

Trigger:

- Every `learning.prRetrospectiveThreshold` handled PRs, default 5.
- Manual command: `/learning review-prs`.
- Optional per-repo trigger when one repo reaches the threshold even if global threshold also exists.

Count a PR as handled when one of these durable events happens:

- review feedback workflow completed
- CI failure workflow completed
- prepared diff created
- prepared diff verified
- prepared diff pushed
- prepared diff abandoned after review
- Kilo result reviewed/promoted/discarded for a PR
- watched PR merged/closed after Neon involvement

Use idempotency keys such as:

- `repoFullName#prNumber:eventType:sourceId`

Inputs:

- recent handled PR list
- repo ids and PR ids
- workflow summaries
- prepared diff summaries
- verification commands and results
- recurring error outputs, bounded and sanitized
- review comments / unresolved feedback summaries
- notifications/recovery actions
- final outcomes
- existing project/local memories for involved repos
- relevant Neondeck skill snippets

Outputs:

- durable memory lessons
- skill patch proposals/applied patches
- policy or workflow recommendations
- "do nothing" with reasons
- per-repo and global review summary

High-value patterns to detect:

- repeated linter/typecheck errors introduced by autofix
- missing repo-specific conventions
- repeated verification command mismatch
- repeated PR feedback missed by GitHub review thread lookup
- repeated push blockers
- recurring Kilo result failure classes
- bad prepared-diff summaries
- cases where Neon should ask earlier or act more autonomously

Example learned outputs:

```json
{
  "memories": [
    {
      "scope": "project",
      "repoId": "neondeck",
      "key": "autofix.valibot-boundaries",
      "value": "Autofix changes touching API/action inputs must use Valibot schemas at IO boundaries; missing schemas caused repeated review feedback."
    }
  ],
  "skillPatches": [
    {
      "skillId": "neondeck",
      "summary": "Add an autopilot pitfall requiring Valibot IO checks before preparing TypeScript fixes."
    }
  ]
}
```

## Learning Snapshot For New Sessions

Replace the current simple memory preview with a deliberate prompt snapshot builder.

Selection order:

1. high-priority active `user` memories
2. active `local` memories relevant to Neondeck runtime/tools
3. active `project` memories for linked repo/task/session context
4. recently reinforced active memories

Exclude:

- `archived`
- suspicious memory
- deprecated `session`/`watch` unless explicitly requested for migration visibility

Record which memory ids were loaded into the session metadata. This makes stale context explainable:

- "This session loaded memory A/B/C."
- "Memory D changed later, so this session is stale."

Add configurable prompt budgets:

```json
{
  "learning": {
    "memoryPromptBudgetChars": 3500,
    "userMemoryBudgetChars": 1000,
    "localMemoryBudgetChars": 1000,
    "projectMemoryBudgetChars": 1500
  }
}
```

Budgets should be conservative and visible in runtime status.

## Safety And Quality Policy

Learning should be capable by default but audited.

Do not learn:

- raw secrets or secret-like values
- one-off task narratives
- transient command failures without a durable fix
- "tool X is broken" from one failure
- broad negative capabilities that may become stale
- obvious facts that are easy to rediscover
- data dumps, logs, or large code blocks

Prefer learning:

- user corrections
- repeated successful workarounds
- repeated failure patterns with evidence
- repo conventions confirmed by code/docs/review feedback
- verification commands that succeeded repeatedly
- workflow rules the user explicitly states

Security scanning:

- reuse or port Hermes-style strict prompt-injection/exfiltration pattern checks for memory content before prompt loading
- rejected suspicious writes should create bounded audit events, not active prompt-loadable memory

Audit:

- every memory mutation should record a concise reason and before/after audit data
- every skill patch must retain diff/backup data
- every learning review should persist model, thinking level, trigger, input summary, and result summary

## Memory Curation Workflow

Create `curate_learning_store`.

Purpose:

- keep the active memory set small and useful
- remove stale or contradicted guidance
- merge duplicates
- rewrite vague memories into crisp current guidance
- preserve audit history without keeping cruft in the prompt working set

Automatic curation should be optional and tuneable:

- `learning.memoryCurationEnabled`, default `true`
- `learning.memoryCurationMode`, default `review`
- `learning.memoryCurationTurnInterval`, default `200`
- `learning.memoryMaxActiveItems`, default `200`

Triggers:

- every configured curation turn interval
- when active memory exceeds `memoryMaxActiveItems`
- manual `/learning curate`
- CLI/API curation request

Modes:

- `off`: no automatic curation
- `review`: create rewrite/merge/archive candidates
- `auto`: directly curate through typed memory actions and audit events

Inputs:

- active `user`, `local`, and relevant `project` memories
- recent memory event summaries
- recent user corrections
- usage counts and last-used timestamps
- prompt budget pressure signals

Outputs:

- rewritten memories
- merged memories
- archived memories
- review candidates when mode is `review`
- short curation summary

The workflow should not try to preserve every historical rationale in memory rows. Memory rows represent current guidance. `memory_events` is the audit/rollback trail.

## Dashboard

Add a Learning panel.

Sections:

- recent learning reviews
- memories learned
- skill patches applied/proposed
- PR retrospective findings
- candidates awaiting approval when mode is `review`
- recent memory curation summaries
- rejected/suspicious write audit events
- model configuration and readiness

Controls:

- run conversation review
- run PR retrospective
- run memory curation
- approve/reject candidate
- archive memory
- rollback skill patch
- open evidence
- start new session to load changes

Keep the panel compact for the Xeneon layout. It should work as a tab in the cockpit layout rather than a separate full page.

## CLI

Add commands:

```sh
neondeck learning status
neondeck learning review
neondeck learning review-prs
neondeck learning curate
neondeck learning curate --review
neondeck learning curate --auto
neondeck learning candidates
neondeck learning approve <id>
neondeck learning reject <id>
neondeck memory list
neondeck memory learn <scope> <key> <value>
neondeck memory archive <scope> <key>
```

Update first-run setup:

- Ask whether learning is enabled.
- Ask for memory/skill write mode, default `auto`.
- Ask whether automatic memory curation is enabled, default `true`.
- Ask for memory curation mode, default `review`.
- Ask for optional self-improvement/reflection model.
- Default the reflection model to utility model when available.
- Ask for reflection reasoning effort, default `low`.

## API

Add local APIs:

- `GET /api/learning/status`
- `GET /api/learning/reviews`
- `POST /api/learning/reviews/conversation`
- `POST /api/learning/reviews/prs`
- `POST /api/learning/curate`
- `GET /api/learning/candidates`
- `POST /api/learning/candidates/:id/approve`
- `POST /api/learning/candidates/:id/reject`
- `GET /api/memories`
- `POST /api/memories/learn`
- `POST /api/memories/:id/archive`
- `GET /api/skills/patches`
- `POST /api/skills/patches/:id/apply`
- `POST /api/skills/patches/:id/reject`

All mutation APIs should use the same local host and same-origin guard as existing app mutation routes.

## Documentation

Update:

- `README.md`
- `AGENTS.md`
- Astro docs:
  - getting started
  - configuration
  - memory/learning
  - commands
  - troubleshooting

Docs should explain:

- memory scopes: `user`, `local`, `project`
- difference between memory, sessions, watches, and skills
- how self-improvement reviews run
- how PR retrospectives work
- how to configure `models.selfImprovement`
- what reasoning levels mean
- how to disable learning or require review
- how to inspect and rollback learning changes

## Migration

Existing memory scopes:

- Keep reading `user` and `project`.
- Keep reading `session` and `watch` for compatibility.
- New writes should allow only `user`, `local`, and `project`.
- Add a one-time migration helper that can:
  - promote useful `session` memories to `project` or `local`
  - convert useful `watch` memories into project lessons where appropriate
  - archive the rest

Do not auto-migrate old `session`/`watch` memories without review.

## Tests

Fast tests should cover:

- config parsing and model fallback
- self-improvement model and thinking level resolution
- memory scope validation
- memory learn/upsert/archive behavior
- memory rewrite/merge behavior
- optional memory curation modes and thresholds
- candidate auto/review/off modes
- prompt snapshot selection and budget behavior
- stale-session marking after memory/skill changes
- PR handled idempotency
- PR retrospective trigger after threshold
- API route validation and guards
- dashboard data adapters where practical

Integration tests should cover:

- conversation learning workflow with mocked model result
- memory curation workflow with mocked model result
- PR retrospective workflow with mocked workflow/prepared-diff history
- skill patch proposal/apply/rollback on a temp skill directory
- rejected suspicious memory write excluded from prompt snapshot

Smoke scripts:

- create temp runtime home
- configure self-improvement model fallback
- create three memories
- run memory curation with mocked reviewer output
- simulate five PR handled events
- run PR retrospective with mocked reviewer output
- verify memory/skill candidate audit rows

Do not make `npm run check` depend on slow real-model calls. Mock reviewer output by default. Real Flue smoke can live behind explicit integration scripts.

## Acceptance Criteria

- Neondeck can learn active `user`, `local`, and `project` memories through typed actions.
- New learning writes no longer use `session` or `watch` memory scopes.
- Display-assistant sessions load a bounded, auditable memory snapshot.
- Self-improvement model and reasoning level are configurable with sane defaults.
- Conversation reflection runs after the configured cadence without blocking chat.
- Memory curation is optional, tuneable, and auditable.
- PR/autopilot retrospectives run after the configured handled-PR threshold.
- Repeated PR failure patterns can become project/local memory.
- Procedural lessons can patch Neondeck skills or create reviewable skill patch candidates.
- Learning events and reviews are visible through API, CLI, and dashboard.
- Active sessions are marked stale when relevant learned context changes.
- All new IO boundaries use Valibot.
- Fast tests stay fast by mocking model/reflection outputs.
