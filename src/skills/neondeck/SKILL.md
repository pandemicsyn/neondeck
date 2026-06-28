---
name: neondeck
description: Understand Neondeck runtime config, schedules, watches, skills, and deterministic action rules.
---

# neondeck Runtime Skill

Neon runs inside neondeck, a local-first developer cockpit for a companion display.

## Runtime Home

Configuration and mutable runtime state live in the configured Neondeck runtime home. Home resolution order is `NEONDECK_HOME`, then `XDG_CONFIG_HOME/neondeck`, then `~/.config/neondeck`.

## Files

- `config.json`: top-level app settings.
- `repos.json`: configured local repositories and GitHub metadata.
- `dashboard.json`: dashboard layout and plugin configuration.
- `schedules.json`: local schedule and briefing configuration.
- `SOUL.md`: stable assistant personality loaded at session start.
- `skills/`: user-provided Agent Skills-compatible folders. New or changed runtime skills require a new session or server restart before they affect agent behavior.
- `data/neondeck.db`: neondeck app state.
- `data/flue.db`: Flue runtime state.

`config.json` can also include `skillRoots`, an array of external directories containing additional runtime skill folders.

## Mutation Rules

Use typed neondeck config actions for mutations whenever they are available. Do not directly edit config files as the primary path. Read, validate, add, update, remove, and reload through deterministic actions so UI buttons and chat commands share the same backend behavior.

Use `neondeck_runtime_status_lookup` when answering readiness, onboarding, model/provider, credential, runtime home, or recent Flue failure questions.

Use `neondeck_safety_policy_lookup` when answering safety, approval, confirmation, destructive mutation, or host execution questions. Read-only actions may run unattended. Safe mutations should be user-directed and audited when they change durable state. Destructive mutations require explicit user confirmation and action input `confirm=true`.

Use `neondeck_execution_policy_lookup` and `neondeck_execution_policy_check` for host execution questions. The execution policy supports `local` now and reserves `exe.dev` as a future sandbox backend. A policy result of `allow` means the proposed single command is preapproved by config; `ask` means interactive user approval is required before any future executor may run it; `deny` means Neon must not run it. Hardline commands cannot be preapproved. Preapproved commands must be single commands without shell operators.

Use `neondeck_config_update_execution_policy` when the user asks to configure execution backends, approval mode, unattended behavior, or preapproved commands. This updates `config.json` and is audited in `config_history`; it does not execute commands.

Use session actions for context lifecycle. Read active session state with `neondeck_session_status` or `neondeck_session_status_lookup`. Start a new session with `neondeck_session_start` when model/config/skill/memory changes need to enter prompt context or when stale session context is blocking a good answer. A new session is not a server restart and does not cancel old Flue work or mutate existing history. Do not imply that memory or skill edits silently change the current active prompt.

Use `neondeck_config_update_agent_models` for display assistant and subagent model changes. Model strings may include provider prefixes such as `kilocode/kilo/auto`, but the provider must already be registered by Neondeck or the Flue runtime. Tell the user active sessions may need a new session or server restart before model changes apply.

Use provider config actions for provider setup. Read provider config with `neondeck_config_read_providers` and update allowlisted provider settings with `neondeck_config_update_provider`. The only current provider config target is `kilocode`; settings are limited to `enabled`, `apiKeyEnv`, and `organizationIdEnv`. Never accept or store raw provider secrets, arbitrary provider ids, or arbitrary base URLs. Tell the user a server restart is required before provider registration changes apply.

Use typed watch actions for PR watches. Add, list, remove, and refresh PR watches through `neondeck_watch_pr_*` actions. Treat `silent` refresh outcomes as no-op checks and avoid notifying the user when nothing changed.

Use scheduler actions for recurring work. Create common automations through `neondeck_schedule_blueprint_create`, inspect durable jobs with `neondeck_scheduler_list_jobs`, and trigger due work with `neondeck_scheduler_tick`.

Use runtime skill tools/actions for skill inspection. List skills with `neondeck_runtime_skills_lookup` and load full skill content with `neondeck_runtime_skill_load`. Use `neondeck_skills_reload` only when a rescan is explicitly requested. Runtime skill changes require a new session before they affect agent behavior.

Use structured memory actions for durable preferences and notes. Use `neondeck_memory_list`, `neondeck_memory_upsert`, and `neondeck_memory_delete` for `user`, `project`, `session`, and `watch` scoped memory. Memory writes update SQLite immediately, but active agent context should stay stable; new or changed memory applies on a new session. Deleting memory requires explicit confirmation.

Use local dev doctor actions for diagnostics. Run `neondeck_dev_doctor_run` or `/dev-doctor` when checking repo status, package scripts, Node version, env keys, dev ports, API health, or runtime database files.

Use PR assistant commands for PR lifecycle help. Run `/explain-ci`, `/summarize-pr`, `/draft-pr-description`, `/prepare-pr`, and `/review-local` through `neondeck_command_run`. These commands gather deterministic GitHub queue/check data or local repo status first, then Neon can provide reasoning from those facts. Do not invent diff contents, CI logs, or review findings that the command did not fetch.

Use release watch scheduling for GitHub check status. Run `/watch-release <repo>` or create a `release-watch` scheduler blueprint. Provider-specific production deploy adapters are future work; direct release watches track the configured default branch, and linked `until prod` PR release watches track the source PR merge SHA until checks are green.

Use Flue workflows for bounded command runs when durable Flue run identity matters. The app provides `command-run`, `briefing`, `watch-pr`, `watch-release`, `dev-doctor`, and `scheduler-tick` workflows over the same deterministic backend operations used by chat commands and UI buttons.

Use command actions for slash commands. Run `/repo-status`, `/review-queue`, `/explain-ci`, `/summarize-pr`, `/draft-pr-description`, `/prepare-pr`, `/review-local`, `/briefing`, `/memory`, `/watch-pr`, `/watch-release`, and `/dev-doctor` through the `command-run` workflow so command results are persisted with a real Flue run id.

Use the bundled `github-gh` runtime skill for GitHub and `gh` CLI decision guidance. Prefer typed GitHub actions first. Treat `gh` as a proposed or future approved host command unless an approved execution action actually runs it.

Ask for confirmation before destructive changes, removing configured repositories, deleting schedules, disabling watches, or replacing user-authored skills. After any accepted change, summarize exactly which file or runtime object changed and what the new value is.
