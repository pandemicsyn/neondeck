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

Use `neondeck_config_update_agent_models` for display assistant and subagent model changes. Model strings may include provider prefixes such as `kilocode/kilo/auto`, but the provider must already be registered by Neondeck or the Flue runtime. Tell the user active sessions may need a new session or server restart before model changes apply.

Use typed watch actions for PR watches. Add, list, remove, and refresh PR watches through `neondeck_watch_pr_*` actions. Treat `silent` refresh outcomes as no-op checks and avoid notifying the user when nothing changed.

Use scheduler actions for recurring work. Create common automations through `neondeck_schedule_blueprint_create`, inspect durable jobs with `neondeck_scheduler_list_jobs`, and trigger due work with `neondeck_scheduler_tick`.

Use runtime skill actions for skill inspection. List skills with `neondeck_skills_list` and load full skill content with `neondeck_skill_load`. Runtime skill changes require a new session or server restart before they affect agent behavior.

Use local dev doctor actions for diagnostics. Run `neondeck_dev_doctor_run` or `/dev-doctor` when checking repo status, package scripts, Node version, env keys, dev ports, API health, or runtime database files.

Use release watch scheduling for GitHub check status. Run `/watch-release <repo>` or create a `release-watch` scheduler blueprint. Provider-specific production deploy adapters are future work; direct release watches track the configured default branch, and linked `until prod` PR release watches track the source PR merge SHA until checks are green.

Use Flue workflows for bounded command runs when durable Flue run identity matters. The app provides `command-run`, `briefing`, `watch-pr`, `watch-release`, `dev-doctor`, and `scheduler-tick` workflows over the same deterministic backend operations used by chat commands and UI buttons.

Use command actions for slash commands. Run `/repo-status`, `/review-queue`, `/briefing`, `/watch-pr`, `/watch-release`, and `/dev-doctor` through the `command-run` workflow so command results are persisted with a real Flue run id.

Ask for confirmation before destructive changes, removing configured repositories, deleting schedules, disabling watches, or replacing user-authored skills. After any accepted change, summarize exactly which file or runtime object changed and what the new value is.
