# neondeck Roadmap

neondeck is a local-first developer cockpit for a companion display. Its agent, Neon, should act as a second brain and autopilot for active engineering work: repo-aware, watchful, concise, and able to turn deterministic signals into useful next actions and, when configured, bounded code changes.

The near-term priority is to build Neondeck's local operating system before deeper dashboard customization: app home, config, SQLite state, repo registry, runtime skills, schedules, watches, and typed Flue actions. The UI should be an efficient surface over that runtime, not the place where core agent behavior lives.

With the runtime foundation in place, the next product focus is autonomy. Neon should move from "tell me what needs attention" toward "watch the work, prepare fixes, delegate larger chunks when useful, and safely push routine changes when policy allows." This requires stronger isolation, worktree orchestration, review-event workflows, delegated agent handoff, push-back policy, and operator-visible audit trails.

## Product Direction

Neon should not be only a chat panel. The dashboard should show live facts, while the agent explains, prioritizes, and acts on those facts.

Core principles:

- Prefer deterministic APIs and local state for facts.
- Use Flue agents for continuing conversations and follow-up.
- Use Flue workflows for bounded operations with run history.
- Use Flue actions for reusable schema-backed, application-controlled operations.
- Use skills for behavior, conventions, and domain guidance.
- Treat chat commands and UI buttons as two frontends over the same backend workflows.
- Keep session context stable: SOUL, selected skills, repo config, and memory summaries should be loaded deliberately rather than silently changing mid-turn.
- Use deterministic watchers first and agent summarization only when a watcher detects a meaningful state change.
- Treat worktrees as the isolation boundary for autonomous PR work. Automated fix workflows should not mutate the user's primary checkout.
- Treat external agent harnesses such as KiloCode as delegated workers that operate inside declared repos or Neondeck-managed worktrees and report durable task state back to Neondeck.
- Prefer bounded autopilot modes over a binary on/off switch: notify-only, draft-fix, auto-fix without push, and auto-fix with push after checks.
- Keep one backend command/event surface so the web dashboard, future TUI, and possible companion surfaces reuse the same runtime.

Flue usage boundaries:

- Use the `display-assistant` Flue agent for continuing, addressable Neon conversations.
- Use Flue workflows for finite, inspectable units of work that should have a run id, events, result, and history.
- Use Flue actions when an agent or workflow needs application-controlled multi-step behavior with Valibot schemas and reusable logic.
- Use Flue tools for direct application lookups or small deterministic operations that the model can call during a response.
- Use Flue skills for procedural guidance and conventions only; skills should point Neon toward tools/actions/workflows, not execute work themselves.
- Use Hono routes for app-owned dashboard/TUI APIs and UI-only reads. Those routes should call the same service functions as Flue tools/actions rather than duplicating business logic.
- Use Neondeck app SQLite for product state such as repos, watches, jobs, worktrees, approvals, notifications, memories, and delegated Kilo tasks. Use Flue SQLite for Flue session, submission, workflow-run, and event persistence.
- Do not keep Flue workflow runs open merely to supervise indefinite background processes. Persist long-lived job state in Neondeck app state and use workflows for bounded admissions, ticks, reconciliations, summaries, verifications, and promotions.

## Roadmap Ordering

Status markers:

- `[x]` complete in the current implementation.
- `[ ]` still planned or only partially implemented.

1. Neondeck home and runtime state.
2. Flue actions for self-configuration.
3. Repo registry and GitHub foundation.
4. Schedules, watches, and blueprint-style automations.
5. Runtime skills and skill reload.
6. Dashboard panels driven by runtime state.
7. Chat session index and session switcher.
8. Worktree-backed PR autonomy and review-feedback autopilot.
9. KiloCode handoff for large delegated work inside managed worktrees.
10. Later TUI/OpenTUI surface over the same backend API.

## Usability Gate

Neondeck is usable when a new local install can answer “what should I pay attention to?” and “why is Neon not working?” without the user reading source code or editing config by hand.

The usability gate requires:

- [x] first-run readiness that identifies missing provider keys, GitHub credentials, repos, schedules, watches, skills, and database issues
- [x] typed configuration for display assistant, utility, and subagent models
- [x] allowlisted provider configuration through secret environment variable references, not raw secrets or arbitrary provider endpoints
- [x] visible session lifecycle controls for new sessions and restart-after-config-change flows
- [x] a work queue that prioritizes review requests, authored PRs, assigned PRs, failing checks, stale work, and active watches
- [x] workflow observability that shows active runs, failed runs, progress events, and safe summaries before linking to raw Flue run inspection
- [x] structured memory that is durable, scoped, and session-stable
- [x] notification policy that dedupes repeated watcher output and distinguishes passive updates from actionable failures
- [x] basic approval semantics for destructive config changes and host execution actions
- [x] actual approved host execution actions for `local` and existing-VM `exe.dev`
- [x] documentation that explains setup, provider/model config, runtime skills, commands, watches, memory, workflow observability, execution policy, and troubleshooting

## Required Capabilities

### Repo Awareness

Maintain a configured registry of local repositories.

The registry should include:

- repo id
- GitHub owner/name
- local filesystem path
- default branch
- production/deploy target
- important package scripts
- optional project/team metadata
- optional watch rules

This registry is the base context for GitHub panels, local dev checks, PR workflows, release watches, and repo-specific skills.

### Self-Configuration

Neon should be able to configure neondeck through chat, but configuration changes must go through deterministic actions with schema validation.

Example request:

```text
add a new repo at ~/src/flue
```

Expected behavior:

1. Resolve and expand the path.
2. Verify the path exists.
3. Verify it is a git repository.
4. Read Git remotes and infer GitHub owner/name when possible.
5. Infer default branch when possible.
6. Ask for clarification only when required information is ambiguous.
7. Update neondeck config through a config action.
8. Validate config.
9. Hot reload the app.
10. Report exactly what changed.

The agent should not freestyle-edit config files. It should use actions such as config read, validate, add repo, update repo, remove repo, add schedule, remove schedule, and reload.

Confirmation policy: bias toward capable agents that can make ordinary validated changes without friction, but require explicit confirmation when a mutation deletes state, changes trust boundaries, expands execution authority, increases autonomy, or changes credentials/provider wiring.

Require confirmation for:

- removing a repo or changing a repo path
- removing schedules or watches
- enabling or increasing autopilot mode
- enabling push-back or changing push destinations
- enabling host execution, adding execution preapprovals, or relaxing execution policy
- provider config changes and secret environment variable reference changes
- deleting or bulk-archiving sessions
- deleting memories
- changing worktree cleanup policy toward faster deletion
- enabling Kilo `--auto`

Do not require confirmation for ordinary validated setup and organization changes such as adding a repo after path validation, renaming a repo/session/panel, pinning or unpinning a session, dashboard layout or preset changes, adding a notify-only watch, adding memory, or reloading SOUL/skills without deleting files.

### Config Home

neondeck should use a local application home for user config, runtime skills, and data.

Resolution order:

```text
NEONDECK_HOME
XDG_CONFIG_HOME/neondeck
~/.config/neondeck
```

Initial layout:

```text
~/.config/neondeck/
  config.json
  repos.json
  dashboard.json
  schedules.json
  skills/
    neondeck/
      SKILL.md
  SOUL.md
  data/
    neondeck.db
    flue.db
```

For v1, keep mutable data under the same home for simplicity. Later, strict XDG support can split data into `XDG_DATA_HOME`.

Keep app and Flue persistence separate:

- `data/neondeck.db`: watches, jobs, notifications, memories, config history, and app state.
- `data/flue.db`: Flue runtime persistence.

Decision: v1 keeps config and mutable data under one `NEONDECK_HOME` tree instead of strict XDG config/data separation. App state and Flue runtime state remain separate SQLite databases.

### Runtime neondeck Skill

neondeck should ship a Flue-agent-facing skill that Neon sees at runtime. This is separate from the repo’s Codex/Kilo development skills.

The runtime skill directory should also be user-extensible. Users should be able to place additional Agent Skills-compatible skill folders under `~/.config/neondeck/skills/`, and neondeck should make those skills available to the Flue agent.

Runtime skill location:

```text
~/.config/neondeck/skills/neondeck/SKILL.md
```

The runtime skill should explain:

- where neondeck config lives
- what config files exist
- how repo registry, dashboard layout, schedules, watches, and skills work
- which config actions to call for mutations
- when to ask for confirmation
- how to summarize config changes

This skill should guide the agent toward deterministic actions, not direct file edits. Additional user skills should extend Neon’s domain knowledge without requiring code changes.

### Work Queue Triage

Neon should answer what needs attention now.

Initial inputs:

- PRs authored by the user
- PRs assigned to the user
- PRs requesting the user review
- CI/check status
- stale PRs
- blocked PRs
- active watches

Expected output:

- prioritized summary
- top next actions
- links to relevant PRs/checks
- compact dashboard state

Flue fit:

- GitHub tools/actions fetch structured data, with read-only lookups exposed as tools when the agent only needs facts during a response.
- Workflows perform triage runs.
- Neon agent summarizes and answers follow-up questions.

### Watchers

Watchers make neondeck useful while it sits on a side display.

Required watcher:

```text
/watch-pr <repo>#<number>
```

Supported input forms should eventually include:

```text
/watch-pr pandemicsyn/neondeck#123
/watch-pr neondeck#123
/watch-pr #123
/watch-pr https://github.com/pandemicsyn/neondeck/pull/123
/watch-pr neondeck#123 until prod
```

PR watch state machine:

1. Record repo, PR number, current PR state, and desired terminal state.
2. Poll or refresh GitHub PR state.
3. Detect merge to default branch.
4. Capture merge commit SHA.
5. Watch default-branch GitHub Actions/checks for that SHA.
6. Mark green when checks complete successfully.
7. Mark attention-needed when checks fail.
8. If deploy target is configured, optionally watch production/deploy status.

Watch state must persist in SQLite and survive restart.

Watchers should be deterministic first. A watcher should fetch structured state, compare it with a persisted watermark or previous snapshot, and do nothing when there is no meaningful change. Agent reasoning should run only for explanation, prioritization, or summarization after a delta is detected.

Decision: `/watch-pr` is a command/action that creates or updates durable watch state. The app scheduler checks that state, and Flue workflows run bounded triage, summary, fix, verify, or notification work only when a watcher detects a meaningful delta.

Neondeck should support a quiet no-op convention for watches. This can be an empty result, explicit `silent` outcome, or `[SILENT]`-style sentinel, but the goal is the same: no notification spam when nothing changed.

### Morning Briefing

Neon should support scheduled briefings.

Briefing contents:

- review requests
- assigned/open PRs
- CI failures
- stale branches or stale PRs
- active watches
- release/deploy status
- top three recommended actions

Scheduling model:

- neondeck owns local schedule configuration and state.
- Flue owns the workflow that performs the briefing.
- Node.js scheduling should use an app scheduler that invokes Flue workflows for finite occurrences or dispatches to a continuing agent only when shared conversation state is intentional.
- Cloudflare deployment can later map to Worker cron/scheduling primitives with the same workflow-versus-agent-dispatch split.
- User-facing schedules should prefer typed blueprints over raw cron strings. Raw schedules can exist underneath, but common flows should be created through presets such as morning briefing, watch PR, release watch, and review queue digest.

### Local Dev Doctor

Neon should understand local repo and machine health.

Checks:

- current branch
- dirty working tree
- unpushed commits
- upstream divergence
- Node version mismatch
- missing env keys
- dev server status
- ports in use
- known package scripts
- typecheck/build/test status
- local database/server status

This should be action-heavy and deterministic, with the agent reserved for explanation and recommendations.

### PR Assistant

Neon should help move PRs through the lifecycle.

Initial commands:

```text
/prepare-pr
/review-local
/summarize-pr
/explain-ci
/draft-pr-description
/rerun-checks
/watch-pr
```

These should be implemented as backend workflows/actions where possible, not only as prompt patterns.

### Worktree Autopilot

Neondeck should use Git worktrees as the isolation layer for autonomous PR work. A watch or schedule should be able to detect actionable changes on multiple PRs, create one isolated checkout per PR or task, run bounded Flue workflows and subagents inside that workspace, and optionally push changes back to the PR branch when policy allows.

Primary use cases:

- PR review feedback lands and contains actionable code comments.
- A watched PR receives requested changes from a human reviewer.
- CI fails after a new PR commit and the failure maps to a deterministic fix path.
- A maintainer asks Neon to "watch this PR and keep it moving."
- Multiple watched PRs need independent triage or fixes at the same time.

Worktree principles:

- Never mutate the user's primary checkout during autonomous fix workflows.
- Create or reuse a dedicated worktree per repo and PR, keyed by repo id, PR number, and head branch/ref.
- Keep same-PR tasks serialized by default with a per-PR lock.
- Allow parallel workflows across different PRs and repos.
- Allow read-only same-PR triage/research in parallel, but serialize same-PR mutation workflows by default.
- Treat created worktrees as declared Neondeck workspaces so repo-edit actions can read and edit files there without approval prompts when path policy passes.
- Keep all file changes routed through repo-edit actions, not ad hoc shell writes.
- Keep shell/test execution routed through the approved execution policy.
- Record every worktree lifecycle event, edit, command, push, PR comment, and cleanup decision in SQLite.

Suggested runtime layout:

```text
~/.config/neondeck/
  worktrees/
    pandemicsyn-neondeck-pr-6/
    org-repo-pr-123/
  data/
    neondeck.db
```

Decision: store Neondeck-owned PR worktrees under `NEONDECK_HOME/worktrees` by default. Allow repo-local `.neondeck/worktrees` as an explicit per-repo option when easier manual inspection matters.

Worktree state should include:

- worktree id
- repo id
- GitHub owner/name
- PR number
- base branch/ref
- head owner/name, head branch/ref, and head SHA
- local path
- owning workflow run id
- lock owner and lock expiration
- lifecycle status: `creating`, `ready`, `busy`, `stale`, `needs-sync`, `failed`, `cleanup-pending`, `deleted`
- last synced SHA
- last pushed SHA
- cleanup policy and last cleanup attempt
- whether direct push-back is allowed
- whether the worktree was created by Neondeck or adopted

Needed actions:

- `neondeck_worktree_create`: create a repo/PR worktree for an isolated task.
- `neondeck_worktree_sync`: fetch and update the worktree to the latest PR head safely.
- `neondeck_worktree_status`: return branch, dirty state, head SHA, base SHA, and lock status.
- `neondeck_worktree_lock`: acquire a per-worktree or per-PR lock for a bounded workflow.
- `neondeck_worktree_release`: release the lock and record final state.
- `neondeck_worktree_cleanup`: remove stale or completed Neondeck-owned worktrees.
- `neondeck_pr_review_comments_lookup`: fetch unresolved review comments and thread metadata.
- `neondeck_pr_requested_changes_lookup`: summarize current requested-changes state.
- `neondeck_pr_push_changes`: push committed worktree changes back to the PR branch when allowed.
- `neondeck_pr_comment`: post a summary comment linking addressed review feedback and checks.
- `neondeck_pr_autopilot_policy_check`: decide whether a watch is notify-only, draft-fix, auto-fix-no-push, or auto-fix-push-after-checks.

Needed workflows:

- `triage_pr_event`: classify a watcher delta as no-op, notify-only, explain-only, draft-fix, or auto-fix.
- `prepare_pr_worktree`: create/sync/lock a PR worktree and gather deterministic facts.
- `fix_pr_review_feedback`: address unresolved review comments in an isolated worktree.
- `fix_pr_ci_failure`: inspect failing checks/logs and attempt a scoped fix.
- `verify_pr_worktree`: run configured checks through the execution policy and summarize results.
- `push_pr_autofix`: push changes back to the PR head branch when policy and permissions allow.
- `comment_pr_autofix_result`: post a concise PR comment explaining what changed, which comments were addressed, and which checks ran.
- `cleanup_autopilot_worktree`: remove or retain worktrees according to policy.

Autopilot modes:

- `notify-only`: detect and notify, but do not create a worktree.
- `draft-fix`: create a worktree, prepare a diff, and surface it for review without committing or pushing.
- `auto-fix-no-push`: create a worktree, commit locally, run checks, and wait for explicit user approval before push.
- `auto-fix-push-after-checks`: create a worktree, commit locally, run configured checks, push when checks pass, and comment on the PR.

Decision: default newly configured repos to `draft-fix`, and make the default configurable globally and per repo.

Worktree cleanup policy:

- retain failed autonomous worktrees for debugging and evidence
- retain prepared diffs until accepted, rejected, superseded, or manually cleaned up
- delete successfully pushed Neondeck-owned worktrees after a configurable grace period
- never automatically delete adopted or user-created worktrees
- expose cleanup controls and stale-worktree state through dashboard and future TUI surfaces

Push-back policy:

- Direct push is allowed only when the GitHub token can write to the PR branch or GitHub reports maintainer push permission for the fork.
- If direct push is not allowed, Neondeck should leave the prepared worktree intact and notify the user with the reason push-back is blocked.
- Do not force-push unless a user explicitly enables a narrowly scoped policy for a repo.
- Before pushing, require a clean worktree except for the intended commit, a diff summary, and configured checks.
- Auto-push requires configured checks to pass by default. Repo policy can explicitly allow push with failing checks for low-risk classes such as docs-only changes.
- Autonomous fixes should create one commit per workflow run, with the commit message referencing the PR and addressed review/check ids.
- Large, generated, secret-like, or high-risk files should require explicit approval even in auto-push mode. Database migrations are a common expected output and should be easy to generate in draft-fix or approved flows, but unattended auto-push of migration changes still requires explicit repo policy or approval.

Direct push-back readiness should verify that the configured GitHub credential can read repository metadata, PRs, checks/statuses, and contents; write contents to the target branch; comment on PRs/issues; and rerun workflows where that feature is enabled. For fork PRs, readiness should verify that GitHub reports maintainer push permission or that the credential can push to the fork branch. Missing permissions should be reported in plain language with the affected repo/branch.

Watch integration:

PR watches should evolve from status tracking into event-driven autonomy. A watcher tick should compare the latest GitHub state with stored watermarks and enqueue workflows only for meaningful deltas:

- new commits on the PR head
- new or changed review comments
- new requested-changes review
- resolved review threads
- check suite/check run failure
- check suite/check run recovery
- base branch changes relevant to the PR
- merge conflict or branch out-of-date state

Same-PR events should be reconciled so Neon does not launch duplicate fix workflows for the same review thread or failing check. Different PRs should be able to run in parallel within configured concurrency limits. Same-PR mutation workflows should serialize by default, while read-only triage and research can run concurrently.

Watcher state, reconciliation, and queue admission belong to Neondeck app state. Flue workflows should represent the bounded work admitted from that state, such as triage, prepare, fix, verify, push, comment, and cleanup runs.

Concurrency controls:

- global max autonomous jobs
- global max active Flue workflow runs admitted by the autopilot queue
- per-repo max autonomous jobs
- per-PR single active mutation workflow by default
- per-PR parallel read-only triage/research where useful
- per-host execution concurrency for local checks
- queue priority for urgent failures, requested changes, active user asks, and ready-to-push work

Dashboard and future TUI needs:

- active autopilot queue
- active worktrees and locks
- per-PR autopilot mode
- pending push approvals
- prepared diffs
- checks currently running
- recent autonomous fixes
- failed or blocked attempts with recovery guidance

Runtime skill guidance:

The Neondeck runtime skill should teach Neon that worktrees are the normal isolation boundary for autonomous PR work. Neon should gather deterministic PR facts first, then use workflows/actions for edits and checks, and only reason from those facts. It should clearly distinguish inference from fetched GitHub/check/worktree state.

### KiloCode Handoff

Neondeck should be able to delegate large or long-running chunks of work to KiloCode while keeping Neon as the supervising assistant and Neondeck as the durable runtime of record.

KiloCode should be treated as a worker in the toolbox, not as a second Neondeck runtime. Neon decides when handoff is useful, Neondeck creates or selects the workspace, Neondeck records task/session state, and Neondeck owns verification, review, approvals, and push-back decisions.

Decision: Kilo delegation is a minimal explicit handoff feature for exploration. Agents should not delegate to Kilo by default. The normal path is for Neon to do the work itself or delegate to Neon subagents; Neondeck delegates to Kilo when the user explicitly asks for Kilo or when a future repo/workflow policy explicitly opts into Kilo handoff.

Primary use cases:

- a watched PR receives substantial review feedback
- CI failure investigation needs a larger code-reading/fixing loop
- a user asks Neon to "take this larger task" without blocking the chat session
- scheduled repo maintenance or upgrade work should run in the background
- multiple repos or PRs need independent delegated work in parallel

Preferred operating model:

- Run Kilo inside a declared repo or Neondeck-managed worktree.
- Prefer worktrees for autonomous mutations so the user's primary checkout is not touched.
- Track every Neondeck handoff as a durable task in `data/neondeck.db`.
- Capture the Kilo session id created by the handoff.
- Capture child Kilo session ids where available.
- Persist Kilo event summaries so the dashboard and future TUI can show progress.
- Capture final git status and diff summary before any verification or push.
- Keep checks, commits, pushes, and PR comments under Neondeck workflows and policy.
- Treat the Kilo process/server supervisor as a Neondeck app service, not as a long-lived Flue workflow. Flue workflows should start, summarize, review, verify, promote, or reconcile Kilo tasks as bounded runs.

Initial integration path:

- Start with `kilo run --format json --dir <worktree> --title <task-title> --auto` as a background task.
- Parse JSON-line events and store the root `sessionID` as soon as it appears.
- Use `kilo session list --format json --all --search <task-title>` only as a recovery path if the event stream does not yield a session id.
- Trust Kilo to operate with `--auto` in `draft-fix` when running inside a Neondeck-managed worktree. Neondeck should provide explicit task prompts, keep verification and push policy in Neondeck, and allow stricter repo policy when needed.

Decision: the first Kilo integration should be CLI JSON streaming. Evaluate managed `kilo serve` plus SDK after the durable task model, event capture, and review/verification flow are proven.

Target integration path:

- Add a managed Kilo server supervisor around `kilo serve`.
- Use `@kilocode/sdk/v2` or a small typed HTTP client to create sessions, call `promptAsync`, subscribe to events, abort running work, inspect messages, inspect child sessions, and read diffs.
- Keep CLI mode as a fallback.
- Punt ACP. Do not add a generic delegated-harness adapter until Kilo-specific handoff has proven useful and there is a concrete need.

Kilo task retention and reconciliation:

- Store structured Kilo event summaries in SQLite for querying and dashboard/TUI display.
- Store raw JSONL logs under `NEONDECK_HOME/data/kilo/logs/` when raw retention is enabled.
- Make raw log retention configurable.
- Persist process id, start time, cwd, title, task id, known Kilo session ids, and raw log path for CLI tasks.
- On Neondeck restart, mark in-flight CLI tasks as `needs-reconcile`.
- Recover task/session state with `kilo session list --format json --all --search <title-or-task-id>`.
- If the process is still running and owned by Neondeck, reattach or continue tailing the log when possible.
- If process state cannot be proven, mark the task `unknown` or `needs-review` with the last captured event and final observed git status.

Kilo concurrency should use a separate delegated-worker pool because Kilo tasks may be long-running and heavier than ordinary Flue workflow runs. Keep Kilo concurrency, local execution concurrency, and autopilot workflow concurrency separately configurable, with a global host-cap above them.

Kilo config should expose enabled state, CLI path, default model, default agent, mode defaults, `--auto` policy, concurrency, raw log retention, and per-repo overrides. Kilo should not inherit Neon subagent model defaults by default; treat inheritance as a future explicit option if it becomes useful.

Needed runtime state:

- Kilo task id
- source workflow/watch/command id
- repo id and worktree id
- target cwd
- title and prompt preview
- mode: `research`, `implementation`, `review-feedback-fix`, `ci-fix`, or `maintenance`
- status: `queued`, `starting`, `running`, `completed`, `failed`, `cancelled`, `needs-review`, `ready-to-verify`, or `ready-to-push`
- Kilo root session id
- child session ids
- process id or managed-server run id
- model and agent selection
- started/ended timestamps
- exit code and bounded output previews
- event counts and latest event summary
- final diff summary
- raw JSONL log path when raw log retention is enabled
- reattach/reconcile status after Neondeck restart

Needed actions:

- `neondeck_kilo_task_start`: start a Kilo handoff in a declared repo/worktree.
- `neondeck_kilo_task_status`: read durable task state and latest event summary.
- `neondeck_kilo_task_events`: page through persisted task events.
- `neondeck_kilo_task_abort`: cancel a running Kilo task and mark it cancelled.
- `neondeck_kilo_task_sessions`: list linked root/child Kilo sessions for a task.
- `neondeck_kilo_task_diff`: return post-handoff git status and diff summary.
- `neondeck_kilo_sessions_search`: search Kilo sessions by title, repo, directory, time window, Neondeck task id, or Kilo session id.
- `neondeck_kilo_session_read`: read bounded session metadata, transcript snippets, todos, children, and optional diff.
- `neondeck_kilo_session_messages`: page through normalized session messages when a user explicitly needs transcript detail.
- `neondeck_kilo_session_children`: list child sessions created by Kilo task/subagent tools.
- `neondeck_kilo_session_todos`: read Kilo session todos.
- `neondeck_kilo_session_diff`: read Kilo's session diff through SDK/API when available.

Needed workflows:

- `handoff_to_kilo`: resolve workspace, lock worktree, construct constrained prompt, start or admit Kilo work through the app supervisor, persist the initial task/session ids, and release the workflow when the handoff has been durably admitted or completed.
- `reconcile_kilo_task`: poll or reattach to an existing Kilo task, persist new events, capture final git status/diff when complete, and release locks according to policy.
- `summarize_kilo_session`: resolve and read a Kilo session, then produce a bounded summary of intent, actions, changes, blockers, and recommended next steps.
- `review_kilo_result`: inspect changed files, summarize risk, and decide whether the result needs human review, verification, or discard.
- `verify_kilo_result`: run configured checks through Neondeck execution policy.
- `promote_kilo_result`: commit, push, or comment only when Neondeck autopilot policy allows.

Session read/search policy:

- Prefer managed Kilo SDK APIs: session list/search, get, messages, children, todos, status, and diff.
- Use `kilo session list --format json --all --search <query>` as the CLI fallback.
- Use direct disk reads only as an internal read-only recovery adapter when SDK and CLI access are unavailable.
- Normalize SDK, CLI, and disk results into one schema before exposing them to Neon.
- Return bounded transcript snippets by default for UI and context ergonomics.
- Do not redact Kilo transcripts, tool outputs, or diffs by default; Kilo is another trusted local agent harness.
- Use very basic audit only: record task/session ids, read type, requester surface, and timestamp for session reads.
- Maintain a local metadata index for Kilo sessions linked to Neondeck tasks. Query Kilo on demand for broader unlinked searches because they should be rare, and cache only sessions that are referenced or linked.
- Start disk fallback with current Kilo SQLite storage. Treat legacy JSON as a later best-effort recovery adapter only if implementation shows it is needed.
- Teach the runtime skill that Neon should call Kilo session actions/workflows instead of reading Kilo storage directly.

Child Kilo sessions should be represented as a tree under the root Kilo task. Audit records should store parent/child ids and basic event summaries. Dashboard and future TUI should show child sessions collapsed by default with title, status, and latest summary.

Dashboard and future TUI needs:

- active Kilo task queue
- Kilo session ids and child sessions
- live event preview
- changed files and diff summary
- verification state
- pending review/push approvals
- abort, retry, discard, verify, and promote controls
- session search by title, repo, worktree, Kilo session id, or Neondeck task id
- paginated compact transcript view
- linked todos, child sessions, and Kilo diff summaries

Research note:

- `.plans/KILOCODE_HANDOFF_RESEARCH.md`

### Memory

Use structured memory, not only chat transcript.

Memory categories:

- project memory: repo conventions, test commands, deploy rules
- user memory: preferred summary style, notification preferences, working hours
- session memory: current task, active PR, debugging thread
- watch memory: active watches and last observed state

Store important operational state in SQLite/config. Use chat history for conversational continuity, not as the only source of truth.

Memory should be session-stable. Writes should update durable state immediately, but current agent context should not silently change mid-session. New or changed memory should enter prompt context on a new session, explicit context refresh, or another deliberate session lifecycle event.

### Skills

Neon should use skills for domain guidance.

Initial skills:

- Flue skill
- GitHub/gh skill
- local-dev skill
- CI debugging skill
- release/deploy skill
- repo-specific skills

Distinction:

- Skills teach reasoning and behavior.
- Actions do deterministic work.
- Workflows compose repeatable operations.

Skill loading should follow progressive disclosure:

- list metadata first
- load full `SKILL.md` only when needed
- load references, scripts, and assets explicitly
- support reload without requiring a full app restart

Runtime skills should be registered as Flue skills, not appended as ad hoc prompt text. Built-in Neondeck guidance should remain app-owned, while user skills under runtime home and configured external roots should be treated as trusted local extensions with validation and bounded resource loading.

Decision: load bundled app skills plus user skills from `NEONDECK_HOME/skills`. Do not copy built-in skills into home by default. Development can opt into additional local repo skill paths through explicit dev config or environment settings.

### Command Surface

Chat should support slash commands with predictable behavior.

Initial command set:

```text
/briefing
/repo-status
/review-queue
/watch-pr
/watch-release
/explain-ci
/prepare-pr
/dev-doctor
/memory
```

Each command should also be invokable through UI controls where appropriate.

Near-term command expansion:

```text
/explain-ci
/summarize-pr
/draft-pr-description
/prepare-pr
/review-local
```

These should be backend workflows/actions first and prompt patterns second. The agent should fetch deterministic repo/GitHub/check state before reasoning.

### Notifications

Notifications should be glanceable on the Xeneon display.

Levels:

- `info`: passive update
- `ready`: PR merged, checks green, task complete
- `attention`: review requested, CI failed, watch blocked
- `urgent`: main broken, production deploy failed

The UI should surface these in statusline, event feed, and relevant panels.

Notifications should have a clear attention policy:

- dedupe or reconcile by source/source id
- distinguish passive info from actionable failures
- support read/resolve flows
- avoid emitting notifications for quiet watcher no-ops
- use the deck UI notification inbox/statusline as the primary surface
- use native desktop notifications where available, starting with macOS `osascript`/Notification Center support
- defer email, Slack, Discord, and other remote notification delivery until the local workflow is solid

### Runtime Readiness

Neondeck needs an explicit readiness surface so users know whether Neon is usable.

Readiness should include:

- runtime home path
- active config file paths
- Kilo/agent provider key presence
- GitHub token presence
- configured display assistant model
- configured low-cost utility model
- configured subagent models
- registered provider ids
- configured repo count
- active schedules and watches
- loaded runtime skills and duplicate/ignored skill entries
- latest Flue run failures
- app database and Flue database status

This should be available as a deterministic API and as a dashboard panel. The agent should use the same facts when answering “is Neon ready?” or “why is Neon failing?”.

### Testing And Smoke Strategy

Neondeck should treat Flue workflows as first-class smoke-test boundaries. Deterministic services and actions should still be tested directly with Vitest, but workflows should also be exercised through the same Flue surfaces that production and the dashboard use.

Testing layers:

- Unit tests for deterministic app services, tools, actions, policy checks, parsers, path safety, GitHub normalization, worktree state machines, and Kilo event parsing.
- Fixture-driven integration tests with temporary `NEONDECK_HOME`, temporary repos/worktrees, fake GitHub responses, fake Kilo JSONL streams, and isolated SQLite databases.
- Flue workflow smoke tests that invoke discovered workflows with `flue run workflow:<name>` or `@flue/sdk` `client.workflows.invoke(..., { wait: 'result' })`.
- Workflow run inspection tests that assert workflow summaries, emitted `data` progress, run ids, and observed events are recorded in app state.
- Local smoke scripts for the happy path: create watch, run scheduler tick, inspect workflow summary, verify notification, and confirm no-op watcher silence.
- Evals only for model-sensitive behavior such as explanation quality, triage prioritization, and summary usefulness. Do not use evals for deterministic watch or worktree mechanics.

Every planned autonomous workflow should have a non-model fixture path first. For example, `triage_pr_event`, `prepare_pr_worktree`, `fix_pr_review_feedback`, `verify_pr_worktree`, and `push_pr_autofix` should be smoke-testable without live GitHub by injecting structured PR/check/review fixtures and temporary repos.

First-party workflows that are useful to inspect from tests or UI should expose guarded `runs` middleware so SDK clients and the dashboard can fetch run records/events. CLI smoke tests can use `flue run` against the local authored `/api/flue` mount to verify routing, middleware, persistence, and workflow behavior together.

### Provider And Model Configuration

Users should be able to configure model strings for the display assistant, low-cost utility model, and subagents through typed actions. Neon should be the primary way users configure additional providers.

Neondeck should ask users to configure a low-cost lightweight utility model during setup. This model is for small bounded tasks such as short summaries, session/diff title suggestions, notification text, naming suggestions, compact classification, and other low-stakes utility work. Examples might include a fast Flash/Mini-class model from any supported provider, but Neondeck should store this as a normal provider-qualified model string rather than hardcoding one vendor.

Model config requirements:

- preserve current `config.json` structure
- allow partial display assistant, utility, and subagent model updates
- validate non-empty provider-qualified model strings
- record config history
- tell users that active sessions may need a new session or server restart
- expose the utility model as a named model role usable by workflows/actions for small bounded tasks

Provider config requirements:

- allow Neon to configure any provider type and provider field that Neondeck explicitly supports through a typed provider schema
- validate provider ids, base URLs, model strings, headers, and provider-specific options according to the selected supported provider schema
- support provider-specific secret references rather than storing raw secrets in ordinary config, unless a provider schema intentionally supports a local non-secret value
- require a server restart for provider registration changes unless Flue exposes a safe dynamic provider registration mechanism
- surface missing credentials in readiness status and dev doctor
- keep provider registration deterministic and auditable

### Agent And Subagent Topology

Neondeck should treat the display assistant, utility model, and subagents as named runtime roles, not anonymous model calls.

Runtime roles should include:

- display assistant
- low-cost utility model role for small bounded tasks
- code review subagent
- Flue idiom review subagent
- CI/debugging subagent
- local-dev doctor subagent

Decision: v1 should expose and document `repo_researcher`, `ci_investigator`, `code_reviewer`, `release_reviewer`, and `flue_idiom_reviewer` as named configurable roles. Low-level summarizers, classifiers, and one-off workflow helper agents can remain app-internal until there is a user-facing reason to configure them.

Each role should have configurable model selection through `config.json`, with safe defaults and readiness warnings when the configured provider is unavailable. The utility model should be easy to swap independently from Neon’s primary display-assistant model so users can keep small tasks cheap. Subagents should be spawned through typed app helpers or Flue workflows/actions so their inputs, outputs, and summaries can be audited.

The agent should be allowed to update display assistant, utility, and subagent model choices only through typed model config actions. It should not directly edit config files or create arbitrary provider registrations.

### Workflow Observability

The dashboard should make Flue activity inspectable enough that Neon is not a black box.

Required views:

- active workflow runs
- recent workflow failures
- command/workflow summaries linked to Flue run ids
- emitted `data` progress events
- structured action logs
- slow or failed operations
- recent model/tool activity summaries where safe to show

Raw run inspection can expose prompts, inputs, outputs, and tool data, so access should remain local/guarded and UI summaries should avoid leaking secrets.

### Session Lifecycle

Neondeck should make session lifecycle explicit.

Required controls:

- show current Neon session id/state
- start a new session
- switch between existing Neon sessions
- rename, pin, and archive sessions without deleting Flue history
- restart session after skill/model/config changes
- explain when current session context is stale
- eventually support explicit context refresh if Flue exposes a safe mechanism

Session lifecycle matters because SOUL, selected skills, memory summaries, repo config, and model choices should be loaded deliberately rather than mutating under active conversation.

Decision: active sessions should not silently observe SOUL, skill, memory, model, provider, or repo config changes mid-session. Mark affected sessions stale and use a new session, or a future explicit context-refresh flow if Flue exposes a safe mechanism.

Flue should continue to own the actual conversation history for each `display-assistant/:id` agent instance. Neondeck should own the session index, active-session selection, titles, pinned state, archived state, session kind, associated repo/watch/task ids, and stale-context flags in app SQLite.

Running Neon sessions should also be able to search and read other Neon sessions through bounded tools/actions. This lets a user say things like "use the migration discussion from yesterday" or "compare this with the PR watch session" without manually copying context. The agent should receive search results, metadata, summaries, and bounded transcript snippets by default, not unrestricted raw history.

For v1, cross-session search should index session metadata and summaries only. Do not maintain a full-text transcript index yet.

Session kinds should include:

- `main`: default always-available Neon session
- `scratch`: user-created ad hoc session
- `repo`: repo-focused working session
- `watch`: session linked to a PR/release watch
- `task`: session linked to a command, workflow, Kilo handoff, or autopilot task
- `briefing`: session created from a scheduled or manual briefing

Needed session operations:

- create session from a kind and optional context
- list recent, pinned, and archived sessions
- search sessions by title, kind, linked repo/watch/task id, recency, summary text, or explicit session id
- read bounded session metadata, summary, and transcript snippets for one session
- page through transcript excerpts only when explicitly needed
- set active session for a UI surface
- rename session
- pin or unpin session
- archive or restore session
- mark stale context reasons after SOUL, skill, memory, model, or provider config changes
- create or link a session from a watch, workflow summary, repo, or delegated task

Session read/search policy:

- running agents can search and read other Neon sessions without additional approval gates
- search should return compact metadata and summaries by default for performance and scanning
- read should support summaries, bounded excerpts, and paginated transcript access
- session reads should be audited for traceability, not used as a permission gate
- agents should cite which session they used when answering from another session's context

The Xeneon dashboard should keep one focused chat panel by default, with a compact switcher in the panel header. Side-by-side chats can be a later layout mode, but the first version should optimize for fast switching and readable single-session output.

Session lifecycle should also support operator-friendly setup flows:

- after model or provider config changes, explain whether a new session, server restart, or both are required
- after skill reload, show which skills changed and whether the active session is still using older context
- after memory writes, show that durable state changed without implying the current prompt context changed
- expose a deterministic status endpoint/action that the agent can call before answering setup or troubleshooting questions

### Safety And Approvals

Before adding broader local shell or code-changing actions, Neondeck needs an approval model.

Design requirements:

- classify actions as read-only, safe mutation, destructive mutation, or host execution
- require confirmation for destructive repo/config/watch changes
- audit mutation actions in `config_history` or app state
- keep host filesystem and shell access action-mediated by default
- support a config-backed execution approval policy before adding shell executors
- allow users to preapprove specific single commands through audited config
- model `local` as the default backend and `exe.dev` as the planned sandbox backend
- only consider Flue `local()` or host execution actions after they call the approval policy and write approval/audit records

Chat-mediated approvals should be supported. A user should be able to approve an approval request directly in chat, and the application should record that user-originated chat event as the approval decision for audit and execution-policy purposes.

Default local preapproval policy should support real developer workflows. Users choosing Neondeck should expect it to run common `git` and `gh` operations on declared repos. Preapprove common status, inspection, commit, branch, push, PR, check, and rerun commands by default with audit records, while keeping explicitly destructive operations policy-gated.

Default-preapproved examples:

- `git status`, `git diff`, `git log`, `git branch`, `git rev-parse`, `git remote`
- `git add`, `git commit`, `git push`, and ordinary branch creation inside declared repo/worktree roots
- `gh pr view`, `gh pr status`, `gh pr checks`, `gh pr comment`, `gh pr ready`, `gh pr edit`, `gh pr create`
- `gh workflow run`, `gh run view`, `gh run watch`, `gh run rerun`
- package metadata/version reads such as `node --version`, `npm --version`, `pnpm --version`, and `npm pkg get`

Policy-gated by default:

- force-push, branch deletion, reset/clean, merge/rebase operations that rewrite or discard work, repo deletion/archive, secret mutations, dependency installs, and arbitrary package scripts unless configured for a repo.

exe.dev remote execution should use the existing configured remote Linux VM as the primary model. Neondeck can checkout and sync whichever declared repos or managed worktrees it needs on that VM rather than owning VM creation/reuse lifecycles in the near term.

exe.dev environment handling:

- forward repo-local `.env` files and similar repo-declared environment files when the selected repo/checkout policy enables them
- support per-repo and per-checkout environment variables in Neondeck config
- support environment variables sourced from the host or Neondeck config when explicitly configured for that repo/checkout
- do not apply heuristic name-based env var redaction
- record which env sources were used for a run in audit metadata

First-run setup decision: the CLI setup flow is the recommended onboarding path and should remain documented as such. The dashboard readiness panel and chat setup flows supplement CLI setup after the provider/runtime is working; they are not the primary bootstrapping path.

First-run setup should ask for the primary display assistant model and an optional low-cost utility model. If the user skips the utility model, Neondeck should fall back to the display assistant model and show a readiness recommendation, not a hard failure.

### Extensibility

Backend extension points:

- actions
- workflows
- slash commands
- scheduled jobs
- repo adapters
- notification emitters
- skills

Display extension points:

- PR queue panel
- active watches panel
- chat panel
- host metrics panel
- CI/deploy status panel
- briefing panel
- memory/current-task panel

Runtime extension points should be shared by all UI surfaces. The web dashboard should call the same backend APIs/events that a future TUI or OpenTUI client would use.

## V1 Scope

V1 should prove Neon is useful without overbuilding the platform.

Must-haves:

1. [x] neondeck home resolution and bootstrapping under `NEONDECK_HOME` / `~/.config/neondeck`.
2. [x] Runtime skill loading from neondeck home.
3. [x] Flue actions for validated config management.
4. [x] Repo registry config.
5. [x] GitHub token integration.
6. [x] GitHub PR queue panel.
7. [x] `/briefing` workflow.
8. [x] `/watch-pr` workflow and persistent watch state.
9. [x] Local SQLite persistence for watches, app state, and Flue runtime state.
10. [x] Deterministic GitHub tools/actions.
11. [x] GitHub/gh runtime skill.
12. [x] Disk-backed config reads and explicit config reload actions.
13. [x] Live config-change event fanout to every UI surface.
14. [x] One Neon agent session with command handling.
15. [x] UI panels for PRs, active watches, runtime state, and chat.
16. [x] Dedicated briefing panel.
17. [x] Backend event/API shape suitable for reuse by a future TUI.
18. [x] Runtime readiness/status panel and API.
19. [x] Typed model config actions for display assistant, utility, and subagent models.
20. [x] Flue workflow/run observability for recent command and scheduler activity.
21. [x] Structured memory actions for user, project, session, and watch memory.
22. [x] Named subagent roles with configurable model choices.
23. [x] Dedicated subagent run summary dashboard beyond current Flue observations.
24. [x] Config-backed execution approval policy for `local` and planned `exe.dev` backends.
25. [x] Approved host execution actions for `local` and `exe.dev`.

## Suggested Implementation Phases

### Phase 1: neondeck Home and Runtime State

- Status: complete for current runtime-state needs.

- [x] Add neondeck home resolver:
  - `NEONDECK_HOME`
  - `XDG_CONFIG_HOME/neondeck`
  - `~/.config/neondeck`
- [x] Bootstrap default config directory and files on first run.
- [x] Add default file layout:
  - `config.json`
  - `repos.json`
  - `dashboard.json`
  - `schedules.json`
  - `SOUL.md`
  - `skills/`
  - `data/neondeck.db`
  - `data/flue.db`
- [x] Update Flue runtime persistence to use `data/flue.db`.
- [x] Add app SQLite path and initialization for `data/neondeck.db`.
- [x] Add schema validation for all config files.
- [x] Add disk-backed config reads and explicit reload actions for files under neondeck home.
- [x] Add live config-change event fanout for UI surfaces.
- [x] Add config root/status API so the dashboard can show which runtime home is active.

### Phase 2: Config Management Actions

- Status: complete for current config-management needs.

- [x] Add Flue actions for config operations:
  - read config
  - validate config
  - add repo
  - update repo
  - remove repo
  - add schedule
  - update schedule
  - remove schedule
  - update display assistant, utility, and subagent model settings
  - reload config
- [x] Ensure actions write config atomically.
- [x] Ensure JSON config remains formatted consistently.
- [x] Add config change history in `neondeck.db`.
- [x] Add repo path resolver and Git remote inference.
- [x] Add guarded confirmation flows for destructive config changes.
- [x] Teach the runtime neondeck skill to prefer these actions over direct file edits.
- [x] Emit config-change events so UI surfaces update without reload.
- [x] Keep subagent model updates scoped to known role keys rather than arbitrary dynamic agent definitions.

### Phase 3: Repo and GitHub Foundation

- Status: complete for current GitHub/repo foundation.

- [x] Add repo registry loading from neondeck home.
- [x] Add repo resolver by id, owner/name, local path, and URL for command/workflow inputs.
- [x] Add server-side GitHub API client using `GITHUB_TOKEN`.
- [x] Add deterministic PR listing endpoint.
- [x] Add GitHub PR queue UI states: loading, empty, error, normal.
- [x] Add a GitHub/gh runtime skill that explains when to use GitHub API actions versus local `gh`/git workflows.

### Phase 4: Schedules, Watches, and App State

- Status: complete for local scheduler/watch substrate.

- [x] Add app SQLite tables for watches, jobs, notifications, memories, and workflow summaries.
- [x] Keep Flue runtime persistence separate unless the Flue adapter requires otherwise.
- [x] Add migrations or startup schema initialization.
- [x] Add APIs for active watches and notifications.
- [x] Add local scheduler loop for configured jobs.
- [x] Add blueprint-style job creation for:
  - morning briefing
  - watch PR
  - release watch
  - review queue digest
- [x] Persist watcher watermarks/snapshots.
- [x] Add quiet no-op handling for unchanged watches.

### Phase 5: Runtime Skills

- Status: complete; active-session skill refresh remains a future Flue/session lifecycle question.

- [x] Load built-in Neondeck guidance as an app-owned Flue skill.
- [x] Load runtime skills from neondeck home so users can extend Neon.
- [x] Support additional user-provided skills under `skills/` and configured external skill dirs.
- [x] Validate skill folders enough to ignore obviously broken entries without crashing startup.
- [x] Add skill metadata listing.
- [x] Add explicit full skill loading.
- [x] Add skill reload action.
- [x] Detect duplicate skill ids across built-in, user, and external roots.
- [x] Register active runtime skills as Flue skills with bounded trusted-resource loading.

### Phase 6: Neon Commands and Workflows

- Status: complete for current command set.

- [x] Add slash command parsing for Neon chat.
- [x] Implement `/repo-status`.
- [x] Implement `/review-queue`.
- [x] Implement `/briefing`.
- [x] Implement `/memory`.
- [x] Implement `/watch-pr`.
- [x] Store command results as workflow summaries.
- [x] Expose command workflows through UI buttons.

### Phase 7: PR Watch

- Status: complete for GitHub PR/check watches.

- [x] Implement `/watch-pr`.
- [x] Persist watch config and state.
- [x] Poll GitHub for PR merge state.
- [x] Detect merge commit on default branch.
- [x] Watch GitHub Actions/checks for the merge SHA.
- [x] Notify on success/failure.
- [x] Add active watches panel.

### Phase 8: Dashboard Over Runtime State

- Status: complete for Runtime Overview and current dedicated runtime panels; workflow drilldowns remain future polish.

- [x] Show active neondeck home/status.
- [x] Show readiness status: credentials, provider/model config, databases, repos, schedules, watches, loaded skills, and recent Flue failures.
- [x] Show repos and repo health.
- [x] Show PR work queue.
- [x] Show active watches.
- [x] Show scheduled jobs and last run state.
- [x] Show loaded skills.
- [x] Show recent workflow runs and command summaries linked to Flue run ids.
- [x] Show dedicated briefing, memory/current-task, and subagent summary panels.
- [x] Show one Neon chat session.
- [x] Keep the panel layout optimized for Xeneon Edge, but driven by backend state.

### Phase 9: Local Dev Doctor

- Status: complete for current diagnostic surface.

- [x] Add local repo status actions.
- [x] Add package script detection.
- [x] Add env/key presence checks.
- [x] Add dev server and port checks.
- [x] Add `/dev-doctor` workflow.

### Phase 10: Release Watch

- Status: partially complete; provider-specific deploy adapters remain open.

- [x] Add deploy target metadata to repo registry.
- [x] Support watch until main green.
- [ ] Add provider-specific deploy adapters, starting with Cloudflare after GitHub Actions/checks because `neondeck.dev` is Cloudflare-hosted.
- [x] Add `/watch-release` and “watch until prod” support.

### Phase 11: Work Queue Triage And PR Assistant

- Status: complete for current PR assistant commands; richer diff/check-log ingestion remains future work.

- [x] Promote `/review-queue` into a high-value workflow that prioritizes authored PRs, assigned PRs, requested reviews, failing checks, stale work, and active watches.
- [x] Add `/explain-ci` workflow.
- [x] Add `/summarize-pr` workflow.
- [x] Add `/draft-pr-description` workflow.
- [x] Add `/prepare-pr` workflow.
- [x] Add `/review-local` workflow.
- [x] Use deterministic GitHub/repo/check data before agent reasoning.
- [x] Store workflow summaries and expose them through dashboard controls.
- [x] Route expensive or specialized review/triage work through named subagent roles with configured model choices.

### Phase 12: Structured Memory

- Status: complete for current structured-memory command and dashboard surface.

- [x] Add memory tables/actions for user, project, session, and watch memory.
- [x] Add `/memory` command for listing and updating memory through typed actions.
- [x] Add memory dashboard/current-task panel.
- [x] Keep memory writes durable immediately but session context stable until new session or explicit refresh.
- [x] Avoid echoing full memory blobs after successful updates.

### Phase 13: Provider Configuration And Safety

- Status: complete for config, readiness, dashboard controls, and execution policy; actual executors move to Phase 14.

- [x] Design provider config schema and allowed provider types.
- [x] Use secret references or environment-backed credentials rather than raw secrets in normal config.
- [x] Add typed model config for named agent, utility, and subagent roles.
- [x] Add readiness/dev-doctor checks for provider credentials.
- [x] Add dashboard controls for model choices and provider environment variable references.
- [x] Treat provider registration changes as restart-required until Flue offers a safe dynamic provider mechanism.
- [x] Add approval policy for destructive mutations and host execution actions.
- [x] Keep local shell access action-mediated by default.
- [x] Add config-backed preapproved command policy for `local` and planned `exe.dev` execution.
- [x] Only add actual shell/sandbox execution actions after trust boundaries and audit records are explicit.

### Phase 14: Approved Host Execution And exe.dev Sandbox

- Status: partially complete. Approved local execution and existing-VM `exe.dev` execution now share the approval/audit path; app-owned exe.dev lifecycle orchestration is deferred in favor of using a configured remote Linux VM and syncing declared repos/worktrees there.

- [x] Verify the current Flue `local()` API and exe.dev connector API against installed package docs before implementing executors.
- [x] Add runtime config for execution credentials and sandbox lifecycle using secret environment variable references only.
- [x] Keep `local` as the default trusted-host backend and `exe.dev` as the remote sandbox backend.
- [x] Add an approval request/response table in `neondeck.db` with command, backend, session, context, decision, approver surface, timestamps, and bounded result metadata.
- [x] Add a typed `neondeck_execution_request_approval` action that creates a pending approval without running the command.
- [x] Add dashboard/API approval resolution endpoints for allow once, allow session, allow always/preapprove, and deny.
- [x] Add a local executor action that calls `neondeck_execution_policy_check`, requires approval when the decision is `ask`, refuses `deny`, and records execution audit metadata.
- [x] Add an exe.dev sandbox executor action through the Flue sandbox connector for an existing VM configured by `EXE_VM_HOST` or `execution.exeDev.vmHostEnv`.
- [ ] Add existing-VM exe.dev repo/worktree checkout and sync helpers for declared repos.
- [ ] Add exe.dev per-repo/per-checkout env forwarding from repo-local `.env` files and Neondeck config.
- [x] Ensure both executors share the same hardline deny list, preapproval matching, unattended policy, and audit path.
- [x] Add bounded output capture before exposing execution results to the agent, dashboard, workflow summaries, or notifications.
- [x] Add dashboard controls for pending approvals, recent approvals, and execution failures.
- [x] Add tests for local allowed commands, local approval-required commands, hardline denies, unattended denies, exe.dev policy routing, and approval persistence.
- [x] Document trusted-local versus isolated-sandbox tradeoffs and require users to opt in before enabling `exe.dev`.

### Phase 15: Usability Hardening

- Status: complete for the current usability gate.

- [x] Add a first-run setup/readiness panel that links each failed readiness check to the relevant action or documentation.
- [x] Add command-specific empty, loading, partial, and failure states for review queue, watches, memory, workflow runs, and runtime status.
- [x] Add a dedicated workflow observability drilldown or panel once the runtime overview becomes crowded.
- [x] Add visible session controls for starting a new Neon session and identifying stale config/skill/memory context.
- [x] Add a notification inbox/resolution flow with dedupe by source and source id.
- [x] Add PR assistant command workflows for `/explain-ci`, `/summarize-pr`, `/draft-pr-description`, `/prepare-pr`, and `/review-local`.
- [x] Add docs pages for first-run setup, provider/model config, runtime skills, commands, watches, memory, workflow observability, execution policy, and troubleshooting.
- [x] Add smoke tests that verify a fresh runtime home can boot, report readiness, load skills, update model config, create memory, and run a no-op workflow.

### Phase 16: Chat Session Index And Switcher

- Status: planned.

- [ ] Add `chat_sessions` table in `neondeck.db` for session id, title, kind, pinned/archived state, linked repo/watch/task ids, stale-context reasons, created/updated/last-active timestamps, and UI metadata.
- [ ] Keep Flue conversation history in Flue persistence under `display-assistant/:id`; do not duplicate transcripts into app state.
- [ ] Add deterministic session tools/actions:
  - `neondeck_session_list`
  - `neondeck_session_search`
  - `neondeck_session_read`
  - `neondeck_session_messages`
  - `neondeck_session_create`
  - `neondeck_session_switch`
  - `neondeck_session_rename`
  - `neondeck_session_pin`
  - `neondeck_session_archive`
  - `neondeck_session_restore`
  - `neondeck_session_link_context`
- [ ] Add app APIs/events for recent sessions, active session per surface, and session metadata changes so web and future TUI clients share the same behavior.
- [ ] Add session search/read APIs that return normalized, Valibot-validated results for agents, dashboard, and future TUI.
- [ ] Add session summary generation or refresh so cross-session references can usually use summaries instead of raw transcript pages.
- [ ] Add audit records for session reads, transcript page reads, and cross-session context use.
- [ ] Add dashboard chat-panel switcher with pinned sessions, recent sessions, archived sessions, create-new-session, rename, pin, and archive controls.
- [ ] Add dashboard/TUI affordances for "reference this session" and "open referenced session" without forcing side-by-side chat.
- [ ] Add context-aware session creation from repo rows, PR/watch rows, workflow summaries, briefing summaries, and delegated Kilo/autopilot tasks.
- [ ] Add stale-context badges for sessions affected by SOUL, skill, memory, model, provider, or repo config changes.
- [ ] Update runtime skill guidance so Neon can create, switch, search, read, and cite sessions intentionally instead of treating every topic as one global conversation.
- [ ] Add tests for session CRUD, active-session selection, archived filtering, session search/read policy, audit records, stale-context marking, and linked repo/watch/task sessions.

### Phase 17: Future TUI/OpenTUI Surface

- Status: planned.

- [ ] Reuse the same backend command/event APIs as the web dashboard.
- [ ] Avoid a second agent runtime.
- [ ] Use the shared chat session index and active-session APIs instead of maintaining TUI-only chat state.
- [ ] Keep terminal rendering focused on dense status, command input, and streaming agent output.

### Phase 18: Worktree Runtime Foundation

- Status: complete.

- [x] Add `worktrees/` under Neondeck home and keep all Neondeck-owned PR worktrees there by default, with repo-local `.neondeck/worktrees` as an explicit per-repo option.
- [x] Add SQLite tables for worktree records, locks, lifecycle events, and cleanup attempts.
- [x] Add a worktree path policy that only adopts or creates paths inside declared repo/worktree roots.
- [x] Add deterministic worktree actions:
  - `neondeck_worktree_create`
  - `neondeck_worktree_sync`
  - `neondeck_worktree_status`
  - `neondeck_worktree_lock`
  - `neondeck_worktree_release`
  - `neondeck_worktree_cleanup`
- [x] Add repo registry links from source repo entries to active worktree entries.
- [x] Add per-PR and per-worktree lock semantics, with expiration and stale-lock recovery.
- [x] Teach repo-edit actions to operate against either a base repo checkout or a Neondeck-managed worktree target.
- [x] Ensure worktree repo-edit operations still use repo-relative paths and the same sensitive/generated/path-deny policy.
- [x] Add cleanup policy config:
  - retain after failed autonomous fix
  - retain after prepared diff
  - delete Neondeck-owned worktrees after successful push and a configurable grace period
  - delete stale Neondeck-owned worktrees after age threshold
  - never delete adopted worktrees without explicit user confirmation
- [x] Add dashboard Runtime Overview rows for active worktrees, stale locks, and cleanup failures.
- [x] Add tests for create/sync/status/lock/cleanup behavior, including dirty worktree and stale lock cases.

### Phase 19: PR Event Autopilot

- Status: planned.

- [x] Extend PR watches to persist event watermarks for commits, review threads, requested-changes reviews, check suites, check runs, mergeability, and out-of-date branch state.
- [x] Add a `triage_pr_event` workflow that classifies deltas into no-op, notify-only, explain-only, draft-fix, auto-fix-no-push, or auto-fix-push-after-checks.
- [x] Add deterministic GitHub tools/actions for unresolved review comments, review thread state, requested-changes state, branch push permissions, and PR comment posting.
- [x] Add `prepare_pr_worktree` workflow to create/sync/lock a PR worktree and gather deterministic repo/GitHub/check facts.
- [ ] Add `fix_pr_review_feedback` workflow:
  - fetch unresolved review comments
  - group comments by file/path/topic
  - read relevant files through repo-edit actions
  - plan and apply bounded changes through repo-edit replace/patch actions
  - commit locally with a generated message that references addressed comments
  - produce a prepared diff and summary
- [ ] Add `fix_pr_ci_failure` workflow:
  - fetch failing check metadata and logs where available
  - identify likely failing package script or command
  - run configured diagnostics through approved execution actions
  - apply scoped fixes through repo-edit actions
  - commit locally and summarize confidence and remaining risk
- [x] Add `verify_pr_worktree` workflow to run configured repo checks through the execution approval policy.
- [ ] Add `push_pr_autofix` workflow that pushes only when autopilot policy, GitHub permissions, and checks allow it.
- [ ] When direct push is not possible, leave the prepared worktree intact, mark the attempt blocked, and notify the user with recovery options.
- [ ] Add `comment_pr_autofix_result` workflow that posts concise PR comments with addressed comments, commit SHA, checks run, and any remaining manual asks.
- [x] Add concurrency controls:
  - global autonomous workflow limit
  - per-repo autonomous workflow limit
  - one active mutation workflow per PR by default
  - local execution concurrency limit
- [x] Add dashboard/TUI-ready APIs for active autopilot queue, prepared diffs, pending push approvals, running checks, and recent autonomous fixes.
- [ ] Add notification policy for autopilot:
  - ready when a fix is prepared or pushed
  - attention when push/checks are blocked
  - urgent only for production/main failures
  - quiet no-op when a watch delta is reconciled without action
- [x] Add runtime skill guidance for worktree autopilot, including when Neon must avoid direct edits, when to ask for approval, and how to explain autonomous fixes.
- [ ] Add fixture-driven integration tests for same-PR event reconciliation, cross-PR parallelism, direct-push permission checks, blocked push-back worktrees, and blocked high-risk file changes.
- [ ] Add Flue workflow smoke tests for `triage_pr_event`, `prepare_pr_worktree`, `fix_pr_review_feedback`, `fix_pr_ci_failure`, `verify_pr_worktree`, and `push_pr_autofix` using temporary `NEONDECK_HOME`, temporary repos/worktrees, and fake GitHub/check fixtures.
- [ ] Add local smoke scripts that run watch/autopilot workflows through `flue run` or `@flue/sdk` and assert workflow summaries, notifications, prepared diffs, and run observability records.

### Phase 20: Autopilot Policy And UX Hardening

- Status: planned.

- [x] Add repo-level autopilot config with explicit modes:
  - `notify-only`
  - `draft-fix`
  - `auto-fix-no-push`
  - `auto-fix-push-after-checks`
- [x] Add watch-rule overrides so a single PR watch can be more or less autonomous than the repo default.
- [x] Add policy limits:
  - maximum files changed
  - maximum lines changed
  - denied file globs
  - approval-required file globs
  - required checks before push
  - allowed push destinations
  - no force-push by default
- [x] Add default high-risk approval classes:
  - lockfiles
  - dependency manifest changes that alter dependency versions
  - CI/CD config
  - deployment and infrastructure config
  - auth/security-sensitive code
  - secrets and environment files
  - database migrations unless repo policy explicitly permits unattended migration pushes
  - generated files above a configured size threshold
  - binary files
  - vendored code
  - repo-configured globs
- [x] Add a pending approval flow for prepared diffs and push-back actions.
- [x] Add prepared-diff records in app state that reference the source worktree as the source of truth.
- [x] Add shared prepared-diff APIs/actions for web and future TUI:
  - list prepared diffs
  - read summary
  - read changed files
  - read file diff
  - approve push
  - request revision
  - abandon
  - open worktree path
  - run verification
- [x] Keep git/diff operations in backend services and actions; UI clients should not implement git logic.
- [x] Add a dashboard panel for autopilot decisions, including why Neon did or did not act.
- [ ] Add human-readable audit summaries for autonomous workflows, suitable for PR comments and timeline UI.
- [ ] Add recovery actions:
  - retry after new commit
  - rebase/resync worktree
  - abandon prepared fix
  - push prepared fix
  - clean up worktree
- [ ] Add docs for autonomous modes, trust boundaries, worktree storage, GitHub token permissions, push-back behavior, and how to disable autopilot quickly.

### Phase 21: KiloCode Handoff Runner

- Status: planned.

- [x] Add Kilo handoff config under app config:
  - enabled flag
  - CLI path or command name, defaulting to `kilo`
  - default model and agent overrides
  - default mode for direct-edit versus patch-proposal handoffs, with direct-edit enabled by default only inside Neondeck-managed worktrees
  - `--auto` policy
  - explicit-handoff-only default
  - per-repo allow/deny policy
  - concurrency limits
  - raw log retention policy
- [x] Add SQLite tables for Kilo task runs and Kilo task events.
- [x] Add a Kilo task supervisor that can spawn `kilo run` as a streaming background process.
- [x] Run Kilo only in declared repo paths or Neondeck-managed worktrees.
- [x] Add Kilo CLI MVP command construction:
  - `kilo run <prompt>`
  - `--dir <worktree>`
  - `--title <task-title>`
  - `--format json`
  - `--auto` by default for `draft-fix` work inside Neondeck-managed worktrees
  - optional configured `--model`
  - optional configured `--agent`
- [x] Parse JSON-line output and persist:
  - root `sessionID`
  - event type
  - event summary
  - tool/text/error events
  - child session ids where exposed by Kilo task tool metadata
  - raw JSONL log path when configured
- [x] Add recovery lookup with `kilo session list --format json --all --search <task-title>` when a task starts but no session id was captured.
- [x] Add restart reconciliation for in-flight CLI Kilo tasks using persisted pid/start time/cwd/title/session ids/log path.
- [x] Add typed Kilo actions:
  - `neondeck_kilo_task_start`
  - `neondeck_kilo_task_status`
  - `neondeck_kilo_task_events`
  - `neondeck_kilo_task_abort`
  - `neondeck_kilo_task_sessions`
  - `neondeck_kilo_task_diff`
  - `neondeck_kilo_sessions_search`
  - `neondeck_kilo_session_read`
  - `neondeck_kilo_session_messages`
  - `neondeck_kilo_session_children`
  - `neondeck_kilo_session_todos`
  - `neondeck_kilo_session_diff`
- [x] Implement Kilo session access with layered adapters:
  - managed SDK first
  - CLI `kilo session list --format json` fallback
  - read-only current SQLite disk fallback only for recovery
- [x] Normalize Kilo session search/read results into one Valibot-validated schema before exposing them to Neon, APIs, dashboard, or TUI.
- [x] Add transcript view controls:
  - default bounded snippets
  - explicit limits for transcript page size
  - full transcript/tool output/diff access without default redaction
  - basic audit record for session reads
- [x] Add child Kilo session tree support with collapsed dashboard/TUI display by default.
- [ ] Add `handoff_to_kilo` workflow:
  - resolve repo/worktree
  - acquire lock
  - construct task prompt with constraints
  - start Kilo
  - stream/persist progress
  - capture final git status and diff
  - release lock
- [ ] Add `summarize_kilo_session` workflow:
  - resolve by Neondeck task id, Kilo session id, title query, repo, or worktree
  - read metadata, messages, todos, child sessions, and optional diff through typed actions
  - summarize intent, work performed, changed files, blockers, risk, and next steps
  - persist the summary and link it to the Kilo task/session record
- [ ] Add `review_kilo_result` workflow to inspect the Kilo-produced diff and classify it as discard, needs-review, ready-to-verify, or ready-to-push.
- [ ] Add `verify_kilo_result` workflow to run configured checks through Neondeck execution policy.
- [ ] Add `promote_kilo_result` workflow that can commit/push/comment only when autopilot policy allows.
- [ ] Add dashboard/TUI-ready APIs for active Kilo tasks, task events, session ids, session search, transcript pages, todos, child sessions, changed files, verification state, and pending approvals.
- [x] Add dashboard panels or Runtime Overview rows for active delegated Kilo work.
- [ ] Add notification policy for Kilo handoffs:
  - ready when a task completes and has a reviewable diff
  - attention when Kilo fails, stalls, or produces high-risk changes
  - quiet no-op for cancelled/discarded tasks that were superseded
- [x] Add runtime skill guidance that explains when Neon should hand off to Kilo and how to describe Kilo task results.
- [x] Add runtime skill guidance that Kilo delegation is explicit-handoff only by default; Neon should normally do work itself or use Neon subagents unless the user asks for Kilo or policy opts in.
- [x] Add runtime skill guidance that tells Neon to use Kilo session actions/workflows for session search/read/summarization and to avoid direct Kilo storage reads.
- [x] Add docs for Kilo handoff setup, trust boundaries, worktree behavior, session tracking, cancellation, and troubleshooting.
- [x] Add Kilo handoff smoke tests using a fake `kilo` CLI that emits JSONL events, including session id capture, child session capture, task completion, failure, abort, and restart reconciliation.
- [ ] Add Flue workflow smoke tests for `handoff_to_kilo`, `reconcile_kilo_task`, `summarize_kilo_session`, `review_kilo_result`, `verify_kilo_result`, and `promote_kilo_result` with fake Kilo event streams and temporary worktrees.
- [ ] After CLI MVP, evaluate managed `kilo serve` plus SDK integration:
  - server lifecycle supervisor
  - SDK session creation and `promptAsync`
  - event subscription
  - `session.abort`
  - session list/search, message/todo/children/diff inspection
  - reattach after Neondeck restart
- [x] Defer ACP until Kilo-specific handoff proves useful and a concrete generic-harness need exists.

## Open Questions

All current roadmap questions have been resolved into decisions above. Add new questions here as implementation uncovers them.
