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

1. Neondeck home and runtime state.
2. Flue actions for self-configuration.
3. Repo registry and GitHub foundation.
4. Schedules, watches, and blueprint-style automations.
5. Runtime skills and skill reload.
6. Dashboard panels driven by runtime state.
7. Later TUI/OpenTUI surface over the same backend API.

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

### Notifications

Notifications should be glanceable on the Xeneon display.

Levels:

- `info`: passive update
- `ready`: PR merged, checks green, task complete
- `attention`: review requested, CI failed, watch blocked
- `urgent`: main broken, production deploy failed

The UI should surface these in statusline, event feed, and relevant panels.

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

1. neondeck home resolution and bootstrapping under `NEONDECK_HOME` / `~/.config/neondeck`.
2. Runtime skill loading from neondeck home.
3. Flue actions for validated config management.
4. Repo registry config.
5. GitHub token integration.
6. GitHub PR queue panel.
7. `/briefing` workflow.
8. `/watch-pr` workflow and persistent watch state.
9. Local SQLite persistence for watches, app state, and Flue runtime state.
10. GitHub/gh skill plus deterministic GitHub actions.
11. Config hot reload.
12. One Neon agent session with command handling.
13. UI panels for PRs, active watches, briefing, and chat.
14. Backend event/API shape suitable for reuse by a future TUI.

## Suggested Implementation Phases

### Phase 1: neondeck Home and Runtime State

- Add neondeck home resolver:
  - `NEONDECK_HOME`
  - `XDG_CONFIG_HOME/neondeck`
  - `~/.config/neondeck`
- Bootstrap default config directory and files on first run.
- Add default file layout:
  - `config.json`
  - `repos.json`
  - `dashboard.json`
  - `schedules.json`
  - `SOUL.md`
  - `skills/neondeck/SKILL.md`
  - `data/neondeck.db`
  - `data/flue.db`
- Update Flue runtime persistence to use `data/flue.db`.
- Add app SQLite path and initialization for `data/neondeck.db`.
- Add schema validation for all config files.
- Add config hot reload for files under neondeck home.
- Add config root/status API so the dashboard can show which runtime home is active.

### Phase 2: Config Management Actions

- Add Flue actions for config operations:
  - read config
  - validate config
  - add repo
  - update repo
  - remove repo
  - add schedule
  - update schedule
  - remove schedule
  - reload config
- Ensure actions write config atomically.
- Ensure actions preserve formatting where practical.
- Add config change history in `neondeck.db`.
- Add repo path resolver and Git remote inference.
- Add guarded confirmation flows for destructive config changes.
- Teach the runtime neondeck skill to prefer these actions over direct file edits.
- Emit config-change events so UI surfaces update without reload.

### Phase 3: Repo and GitHub Foundation

- Add repo registry loading from neondeck home.
- Add repo resolver by id, owner/name, local path, and URL.
- Add server-side GitHub API client using `GITHUB_TOKEN`.
- Add deterministic PR listing endpoint.
- Add GitHub PR queue UI states: loading, empty, error, normal.
- Add a GitHub/gh runtime skill that explains when to use GitHub API actions versus local `gh`/git workflows.

### Phase 4: Schedules, Watches, and App State

- Add app SQLite tables for watches, jobs, notifications, memories, and workflow summaries.
- Keep Flue runtime persistence separate unless the Flue adapter requires otherwise.
- Add migrations or startup schema initialization.
- Add APIs for active watches and notifications.
- Add local scheduler loop for configured jobs.
- Add blueprint-style job creation for:
  - morning briefing
  - watch PR
  - release watch
  - review queue digest
- Persist watcher watermarks/snapshots.
- Add quiet no-op handling for unchanged watches.

### Phase 5: Runtime Skills

- Load runtime skills from neondeck home so Neon can understand neondeck itself.
- Support additional user-provided skills under `skills/` and configured external skill dirs.
- Validate skill folders enough to ignore obviously broken entries without crashing startup.
- Add skill metadata listing.
- Add explicit full skill loading.
- Add skill reload action.
- Detect duplicate skill ids across built-in, user, and external roots.

### Phase 6: Neon Commands and Workflows

- Add slash command parsing for Neon chat.
- Implement `/repo-status`.
- Implement `/review-queue`.
- Implement `/briefing`.
- Implement `/watch-pr`.
- Store command results as workflow summaries.
- Expose command workflows through UI buttons.

### Phase 7: PR Watch

- Implement `/watch-pr`.
- Persist watch config and state.
- Poll GitHub for PR merge state.
- Detect merge commit on default branch.
- Watch GitHub Actions/checks for the merge SHA.
- Notify on success/failure.
- Add active watches panel.

### Phase 8: Dashboard Over Runtime State

- Show active neondeck home/status.
- Show repos and repo health.
- Show PR work queue.
- Show active watches.
- Show scheduled jobs and last run state.
- Show loaded skills.
- Show one Neon chat session.
- Keep the panel layout optimized for Xeneon Edge, but driven by backend state.

### Phase 9: Local Dev Doctor

- Add local repo status actions.
- Add package script detection.
- Add env/key presence checks.
- Add dev server and port checks.
- Add `/dev-doctor` workflow.

### Phase 10: Release Watch

- Add deploy target metadata to repo registry.
- Support watch until main green.
- Add provider-specific deploy adapters later.
- Add `/watch-release` and “watch until prod” support.

### Phase 11: Future TUI/OpenTUI Surface

- Reuse the same backend command/event APIs as the web dashboard.
- Avoid a second agent runtime.
- Keep terminal rendering focused on dense status, command input, and streaming agent output.

## Open Questions

- Should strict XDG data separation be added early, or should v1 keep config and data under one `NEONDECK_HOME`?
- Should app state and Flue runtime state share one SQLite database or remain separate?
- Which config mutations require explicit user confirmation?
- Should runtime skills be copied into neondeck home on first run, symlinked in development, or loaded from both bundled and user paths?
- Should `/watch-pr` be an agent command, a workflow, or a command that creates a persistent watcher and invokes workflows per tick?
- What deployment providers should release watch support first?
- How much local shell access should Neon have by default?
- What notification delivery exists beyond the deck UI?
- Should active sessions observe config/skill changes immediately, or only after explicit context reload/new session?
