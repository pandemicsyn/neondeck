# neondeck Roadmap

neondeck is a local-first developer cockpit for a companion display. Its agent, Neon, should act as a second brain for active engineering work: repo-aware, watchful, concise, and able to turn deterministic signals into useful next actions.

## Product Direction

Neon should not be only a chat panel. The dashboard should show live facts, while the agent explains, prioritizes, and acts on those facts.

Core principles:

- Prefer deterministic APIs and local state for facts.
- Use Flue agents for continuing conversations and follow-up.
- Use Flue workflows for bounded operations with run history.
- Use Flue actions for reusable deterministic capabilities.
- Use skills for behavior, conventions, and domain guidance.
- Treat chat commands and UI buttons as two frontends over the same backend workflows.

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

## V1 Scope

V1 should prove Neon is useful without overbuilding the platform.

Must-haves:

1. Repo registry config.
2. GitHub token integration.
3. GitHub PR queue panel.
4. `/briefing` workflow.
5. `/watch-pr` workflow and persistent watch state.
6. Local SQLite persistence for watches, app state, and Flue runtime state.
7. GitHub/gh skill plus deterministic GitHub actions.
8. Config hot reload.
9. One Neon agent session with command handling.
10. UI panels for PRs, active watches, briefing, and chat.

## Suggested Implementation Phases

### Phase 1: Repo and GitHub Foundation

- Add `config/repos.json`.
- Add schema validation for repo registry.
- Add repo resolver by id, owner/name, local path, and URL.
- Add server-side GitHub API client using `GITHUB_TOKEN`.
- Add deterministic PR listing endpoint.
- Add GitHub PR queue UI states: loading, empty, error, normal.

### Phase 2: Persistent App State

- Add app SQLite tables for watches, jobs, notifications, memories, and workflow summaries.
- Keep Flue runtime persistence separate unless the Flue adapter requires otherwise.
- Add migrations or startup schema initialization.
- Add APIs for active watches and notifications.

### Phase 3: Neon Commands

- Add slash command parsing for Neon chat.
- Implement `/repo-status`.
- Implement `/review-queue`.
- Implement `/briefing`.
- Store command results as workflow summaries.
- Expose command workflows through UI buttons.

### Phase 4: PR Watch

- Implement `/watch-pr`.
- Persist watch config and state.
- Poll GitHub for PR merge state.
- Detect merge commit on default branch.
- Watch GitHub Actions/checks for the merge SHA.
- Notify on success/failure.
- Add active watches panel.

### Phase 5: Scheduling and Hot Reload

- Add local scheduler for configured jobs.
- Add config hot reload for repos, dashboard layout, jobs, and skills.
- Add morning briefing schedule config.
- Reconcile scheduler state on config changes and process restart.

### Phase 6: Local Dev Doctor

- Add local repo status actions.
- Add package script detection.
- Add env/key presence checks.
- Add dev server and port checks.
- Add `/dev-doctor` workflow.

### Phase 7: Release Watch

- Add deploy target metadata to repo registry.
- Support watch until main green.
- Add provider-specific deploy adapters later.
- Add `/watch-release` and “watch until prod” support.

## Open Questions

- Which config files should own repo registry, schedule config, and skills config?
- Should app state and Flue runtime state share one SQLite database or remain separate?
- Should `/watch-pr` be an agent command, a workflow, or a command that creates a persistent watcher and invokes workflows per tick?
- What deployment providers should release watch support first?
- How much local shell access should Neon have by default?
- What notification delivery exists beyond the deck UI?
