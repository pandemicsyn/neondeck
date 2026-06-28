# neondeck Roadmap

neondeck is a local-first developer cockpit for a companion display. Its agent, Neon, should act as a second brain for active engineering work: repo-aware, watchful, concise, and able to turn deterministic signals into useful next actions.

The near-term priority is to build Neondeck's local operating system before deeper dashboard customization: app home, config, SQLite state, repo registry, runtime skills, schedules, watches, and typed Flue actions. The UI should be an efficient surface over that runtime, not the place where core agent behavior lives.

## Product Direction

Neon should not be only a chat panel. The dashboard should show live facts, while the agent explains, prioritizes, and acts on those facts.

Core principles:

- Prefer deterministic APIs and local state for facts.
- Use Flue agents for continuing conversations and follow-up.
- Use Flue workflows for bounded operations with run history.
- Use Flue actions for reusable deterministic capabilities.
- Use skills for behavior, conventions, and domain guidance.
- Treat chat commands and UI buttons as two frontends over the same backend workflows.
- Keep session context stable: SOUL, selected skills, repo config, and memory summaries should be loaded deliberately rather than silently changing mid-turn.
- Use deterministic watchers first and agent summarization only when a watcher detects a meaningful state change.
- Keep one backend command/event surface so the web dashboard, future TUI, and possible companion surfaces reuse the same runtime.

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
7. Later TUI/OpenTUI surface over the same backend API.

## Usability Gate

Neondeck is usable when a new local install can answer “what should I pay attention to?” and “why is Neon not working?” without the user reading source code or editing config by hand.

The usability gate requires:

- [x] first-run readiness that identifies missing provider keys, GitHub credentials, repos, schedules, watches, skills, and database issues
- [x] typed configuration for display assistant and subagent models
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

- GitHub actions fetch structured data.
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
- Node.js scheduling can use an app scheduler; Cloudflare deployment can later map to Worker cron/scheduling primitives.
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
- leave room for optional desktop/audio delivery later

### Runtime Readiness

Neondeck needs an explicit readiness surface so users know whether Neon is usable.

Readiness should include:

- runtime home path
- active config file paths
- Kilo/agent provider key presence
- GitHub token presence
- configured display assistant model
- configured subagent models
- registered provider ids
- configured repo count
- active schedules and watches
- loaded runtime skills and duplicate/ignored skill entries
- latest Flue run failures
- app database and Flue database status

This should be available as a deterministic API and as a dashboard panel. The agent should use the same facts when answering “is Neon ready?” or “why is Neon failing?”.

### Provider And Model Configuration

Users should be able to configure model strings for the display assistant and subagents through typed actions. Provider registration is separate and higher risk.

Model config requirements:

- preserve current `config.json` structure
- allow partial display assistant and subagent model updates
- validate non-empty provider-qualified model strings
- record config history
- tell users that active sessions may need a new session or server restart

Provider config requirements:

- do not allow arbitrary provider/base URL/secret editing until validation and allowed provider types are designed
- support provider-specific secret references rather than storing raw secrets in ordinary config
- require a server restart for provider registration changes unless Flue exposes a safe dynamic provider registration mechanism
- surface missing credentials in readiness status and dev doctor
- keep provider registration deterministic and auditable

### Agent And Subagent Topology

Neondeck should treat the display assistant and subagents as named runtime roles, not anonymous model calls.

Runtime roles should include:

- display assistant
- code review subagent
- Flue idiom review subagent
- CI/debugging subagent
- local-dev doctor subagent

Each role should have configurable model selection through `config.json`, with safe defaults and readiness warnings when the configured provider is unavailable. Subagents should be spawned through typed app helpers or Flue workflows/actions so their inputs, outputs, and summaries can be audited.

The agent should be allowed to update subagent model choices only through typed model config actions. It should not directly edit config files or create arbitrary provider registrations.

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
- restart session after skill/model/config changes
- explain when current session context is stale
- eventually support explicit context refresh if Flue exposes a safe mechanism

Session lifecycle matters because SOUL, selected skills, memory summaries, repo config, and model choices should be loaded deliberately rather than mutating under active conversation.

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
10. [x] Deterministic GitHub actions.
11. [x] GitHub/gh runtime skill.
12. [x] Disk-backed config reads and explicit config reload actions.
13. [ ] Live config-change event fanout to every UI surface.
14. [x] One Neon agent session with command handling.
15. [x] UI panels for PRs, active watches, runtime state, and chat.
16. [x] Dedicated briefing panel.
17. [x] Backend event/API shape suitable for reuse by a future TUI.
18. [x] Runtime readiness/status panel and API.
19. [x] Typed model config actions for display assistant and subagent models.
20. [x] Flue workflow/run observability for recent command and scheduler activity.
21. [x] Structured memory actions for user, project, session, and watch memory.
22. [x] Named subagent roles with configurable model choices.
23. [x] Dedicated subagent run summary dashboard beyond current Flue observations.
24. [x] Config-backed execution approval policy for `local` and planned `exe.dev` backends.
25. [ ] Approved host execution actions for `local` and `exe.dev`.

## Suggested Implementation Phases

### Phase 1: neondeck Home and Runtime State

- Status: complete except live config-change event fanout.

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
- [ ] Add live config-change event fanout for UI surfaces.
- [x] Add config root/status API so the dashboard can show which runtime home is active.

### Phase 2: Config Management Actions

- Status: complete except live config-change event fanout.

- [x] Add Flue actions for config operations:
  - read config
  - validate config
  - add repo
  - update repo
  - remove repo
  - add schedule
  - update schedule
  - remove schedule
  - update display assistant and subagent model settings
  - reload config
- [x] Ensure actions write config atomically.
- [x] Ensure JSON config remains formatted consistently.
- [x] Add config change history in `neondeck.db`.
- [x] Add repo path resolver and Git remote inference.
- [x] Add guarded confirmation flows for destructive config changes.
- [x] Teach the runtime neondeck skill to prefer these actions over direct file edits.
- [ ] Emit config-change events so UI surfaces update without reload.
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
- [ ] Add provider-specific deploy adapters, with Cloudflare as the likely first adapter if it remains the primary deployment path.
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
- [x] Add typed model config for named agent and subagent roles.
- [x] Add readiness/dev-doctor checks for provider credentials.
- [x] Add dashboard controls for model choices and provider environment variable references.
- [x] Treat provider registration changes as restart-required until Flue offers a safe dynamic provider mechanism.
- [x] Add approval policy for destructive mutations and host execution actions.
- [x] Keep local shell access action-mediated by default.
- [x] Add config-backed preapproved command policy for `local` and planned `exe.dev` execution.
- [x] Only add actual shell/sandbox execution actions after trust boundaries and audit records are explicit.

### Phase 14: Approved Host Execution And exe.dev Sandbox

- Status: partially complete. Approved local execution and existing-VM `exe.dev` execution now share the approval/audit path; app-owned exe.dev lifecycle orchestration remains planned.

- [x] Verify the current Flue `local()` API and exe.dev connector API against installed package docs before implementing executors.
- [x] Add runtime config for execution credentials and sandbox lifecycle using secret environment variable references only.
- [x] Keep `local` as the default trusted-host backend and `exe.dev` as the remote sandbox backend.
- [x] Add an approval request/response table in `neondeck.db` with command, backend, session, context, decision, approver surface, timestamps, and redacted result metadata.
- [x] Add a typed `neondeck_execution_request_approval` action that creates a pending approval without running the command.
- [x] Add dashboard/API approval resolution endpoints for allow once, allow session, allow always/preapprove, and deny.
- [x] Add a local executor action that calls `neondeck_execution_policy_check`, requires approval when the decision is `ask`, refuses `deny`, and records execution audit metadata.
- [x] Add an exe.dev sandbox executor action through the Flue sandbox connector for an existing VM configured by `EXE_VM_HOST` or `execution.exeDev.vmHostEnv`.
- [ ] Add application-owned exe.dev sandbox creation, reuse/cleanup policy, and credential scoping for `fresh-per-execution`, `reuse-session`, `reuse-repo`, and `user-selected` lifecycle modes.
- [x] Ensure both executors share the same hardline deny list, preapproval matching, unattended policy, and audit path.
- [x] Add bounded output capture and redaction before exposing execution results to the agent, dashboard, workflow summaries, or notifications.
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

### Phase 16: Future TUI/OpenTUI Surface

- Status: planned.

- [ ] Reuse the same backend command/event APIs as the web dashboard.
- [ ] Avoid a second agent runtime.
- [ ] Keep terminal rendering focused on dense status, command input, and streaming agent output.

## Open Questions

- Should strict XDG data separation be added early, or should v1 keep config and data under one `NEONDECK_HOME`?
- Should app state and Flue runtime state share one SQLite database or remain separate?
- Which config mutations require explicit user confirmation?
- Should runtime skills be copied into neondeck home on first run, symlinked in development, or loaded from both bundled and user paths?
- Should `/watch-pr` be an agent command, a workflow, or a command that creates a persistent watcher and invokes workflows per tick?
- What deployment providers should release watch support first?
- Which provider config types are safe enough for runtime self-configuration?
- What named subagent roles should ship in v1 versus remain app-internal?
- Which local shell commands should ship as default preapprovals beyond the current read-only git/status set?
- Which app-owned exe.dev sandbox lifecycle should Neondeck add next after existing-VM support: fresh per execution, reusable per session, reusable per repo, or user-selected?
- Which environment variables may be passed into exe.dev sandboxes, and how should they be scoped/redacted?
- What notification delivery exists beyond the deck UI?
- Should active sessions observe config/skill changes immediately, or only after explicit context reload/new session?
- Should chat-mediated approval ever be added, and if so what non-model capability token prevents Neon from approving its own execution requests?
- Which first-run setup flows should be available through the dashboard versus chat-only actions?
