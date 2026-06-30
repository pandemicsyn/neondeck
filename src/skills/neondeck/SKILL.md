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
- `dashboard.schema.json`: JSON Schema for editor validation of `dashboard.json`.
- `schedules.json`: local schedule and briefing configuration.
- `SOUL.md`: stable assistant personality loaded at session start.
- `skills/`: user-provided Agent Skills-compatible folders. New or changed runtime skills require a new session or server restart before they affect agent behavior.
- `worktrees/`: default root for Neondeck-owned Git worktrees used as isolated workspaces for autonomous or delegated repo work.
- `data/neondeck.db`: neondeck app state.
- `data/flue.db`: Flue runtime state.

`config.json` can also include `skillRoots`, an array of external directories containing additional runtime skill folders. It can also include `worktrees.defaultStorage` and `worktrees.cleanup` policy. Update worktree policy through `neondeck_config_update_worktree_policy`, not direct file edits.

## Mutation Rules

Use typed neondeck config actions for mutations whenever they are available. Do not directly edit config files as the primary path. Read, validate, add, update, remove, and reload through deterministic actions so UI buttons and chat commands share the same backend behavior.

Use `neondeck_runtime_status_lookup` when answering readiness, onboarding, model/provider, credential, runtime home, or recent Flue failure questions.

Use `neondeck_safety_policy_lookup` when answering safety, approval, confirmation, destructive mutation, or host execution questions. Read-only actions may run unattended. Safe mutations should be user-directed and audited when they change durable state. Destructive mutations require explicit user confirmation and action input `confirm=true`.

Use `neondeck_execution_policy_lookup` and `neondeck_execution_policy_check` for host execution questions. The execution policy supports `local` and `exe.dev`; `exe.dev` uses the Flue sandbox adapter against an existing VM. A policy result of `allow` means the proposed single command is preapproved by config; `ask` means interactive user approval is required before running; `deny` means Neon must not run it. Hardline commands cannot be preapproved. Preapproved commands must be single commands without shell operators.

Use `neondeck_execution_request_approval` when a host command needs approval, then wait for the user or dashboard to resolve it. Use `neondeck_execution_run` only when policy preapproves the command or an approval already exists. Never run local or `exe.dev` commands outside that approval/action path, and never approve your own execution request. Approval resolution belongs to dashboard/API/user surfaces only. `neondeck_execution_run` writes bounded redacted output to `execution_approvals`. For `exe.dev`, runtime config should reference environment variable names such as `EXE_VM_HOST`, `EXE_SSH_KEY`, and `EXE_API_TOKEN`; do not ask the user to store raw tokens in config. Treat `exe.dev` as opt-in: it is unavailable until `enabledBackends` includes `exe.dev` and the configured VM host environment variable is present.

Use `neondeck_config_update_execution_policy` when the user asks to configure execution backends, approval mode, unattended behavior, or preapproved commands. This updates `config.json` and is audited in `config_history`; it does not execute commands.

Use session actions for context lifecycle and cross-session references. Read active session state with `neondeck_session_status` or `neondeck_session_status_lookup`. List, search, and read session metadata with `neondeck_session_list`, `neondeck_session_search`, and `neondeck_session_read`; use `neondeck_session_create`, `neondeck_session_switch`, `neondeck_session_rename`, `neondeck_session_pin`, `neondeck_session_archive`, `neondeck_session_restore`, and `neondeck_session_link_context` for controlled metadata changes. Flue owns actual `display-assistant/:id` transcripts; Neondeck app state owns the session index, active surface selection, summaries, links, stale-context reasons, and audit records. Start a new session with `neondeck_session_start` when model/config/skill/memory changes need to enter prompt context or when stale session context is blocking a good answer. A new session is not a server restart and does not cancel old Flue work or mutate existing history. Do not imply that memory or skill edits silently change the current active prompt.

Use `neondeck_config_update_agent_models` for display assistant, utility, and subagent model changes. The utility model is a low-cost role for bounded helper work such as session titles, short summaries, labels, notification text, and compact classification; it is not a user-facing persona. Model strings may include provider prefixes such as `kilocode/kilo-auto/balanced`, but the provider must already be registered by Neondeck or the Flue runtime. Tell the user active sessions may need a new session or server restart before model changes apply.

Use provider config actions for provider setup. Read provider config with `neondeck_config_read_providers` and update allowlisted provider settings with `neondeck_config_update_provider`. The only current provider config target is `kilocode`; settings are limited to `enabled`, `apiKeyEnv`, and `organizationIdEnv`. Never accept or store raw provider secrets, arbitrary provider ids, or arbitrary base URLs. Tell the user a server restart is required before provider registration changes apply.

Use dashboard layout actions for display configuration. Read current layout with `neondeck_config_read` using target `dashboard`. Apply common layouts with `neondeck_config_apply_dashboard_preset`: `classic` keeps GitHub/work on the left third and Neon chat on the right two-thirds; `cockpit` keeps that geometry but adds Watches, Briefing, Memory, Runtime, Workflows, and Subagents as tabs. Use `neondeck_config_update_dashboard_layout` only when a user asks for a custom layout and provide a full validated `dashboard.json` object. Dashboard config has an optional `statusline` with `position` `top` or `bottom`; main `layout.regions` are tab stacks with `tabs[]`. Do not edit `dashboard.json` directly in conversation.

Use typed watch actions for PR watches. Add, list, remove, and refresh PR watches through `neondeck_watch_pr_*` actions. Treat `silent` refresh outcomes as no-op checks and avoid notifying the user when nothing changed.

Use PR event autopilot actions only from structured watcher/API facts. Classify a watcher delta first with `neondeck_autopilot_triage_pr_event`; it returns `no-op`, `notify-only`, `explain-only`, `draft-fix`, `auto-fix-no-push`, or `auto-fix-push-after-checks`. Only prepare an isolated checkout when that result says `shouldPrepareWorktree=true`, then call `neondeck_autopilot_prepare_pr_worktree` to gather deterministic PR/check facts and create, sync, inspect, and lock the managed worktree. These first autopilot workflows do not fix files, commit changes, push branches, or comment on PRs. Explain that event watermark persistence and queue admission belong to the watcher/app state layer.

Use scheduler actions for recurring work. Create common automations through `neondeck_schedule_blueprint_create`, inspect durable jobs with `neondeck_scheduler_list_jobs`, and trigger due work with `neondeck_scheduler_tick`.

Use runtime skill tools/actions for skill inspection. List skills with `neondeck_runtime_skills_lookup` and load full skill content with `neondeck_runtime_skill_load`. Use `neondeck_skills_reload` only when a rescan is explicitly requested. Runtime skill changes require a new session before they affect agent behavior.

Use structured memory actions for durable preferences and notes. Use `neondeck_memory_list`, `neondeck_memory_upsert`, and `neondeck_memory_delete` for `user`, `project`, `session`, and `watch` scoped memory. Memory writes update SQLite immediately, but active agent context should stay stable; new or changed memory applies on a new session. Deleting memory requires explicit confirmation.

Use local dev doctor actions for diagnostics. Run `neondeck_dev_doctor_run` or `/dev-doctor` when checking repo status, package scripts, Node version, env keys, dev ports, API health, or runtime database files.

Use repo edit actions for host repository file work. The Flue sandbox is virtual; configured repositories on disk are declared Neondeck workspaces and should be read or edited only through `neondeck_repo_file_read`, `neondeck_repo_file_search`, `neondeck_repo_file_replace`, `neondeck_repo_file_patch`, `neondeck_repo_file_write`, `neondeck_repo_diff`, and `neondeck_repo_checkout_status`.

Declared repo workspaces are trusted for file reads and edits. Do not ask for approval before reading or editing a file inside a declared workspace when the repo edit action accepts the path. Unsafe targets such as `.git`, private keys, paths outside the workspace, traversal paths, and symlink writes are blocked by path policy instead of being sent to an approval flow. Secret-like files such as `.env` are allowed inside declared workspaces and are marked as sensitive in the edit audit log.

Use worktree actions for isolated repo work. Create or adopt worktrees with `neondeck_worktree_create`, sync with `neondeck_worktree_sync`, inspect with `neondeck_worktree_status`, serialize bounded mutation work with `neondeck_worktree_lock` and `neondeck_worktree_release`, and apply retention policy with `neondeck_worktree_cleanup`. Worktrees may live under `NEONDECK_HOME/worktrees` by default or under a repo-local `.neondeck/worktrees` root when explicitly configured. Neondeck only creates or adopts worktree paths inside declared roots.

For autonomous PR fixes, delegated Kilo work, or other agent-driven mutations, prefer a Neondeck-managed worktree over the user's primary checkout. Pass `worktreeId` to repo-edit actions when reading or editing inside that isolated workspace. Keep same-PR mutation work serialized with a PR or worktree lock. Do not use worktrees to bypass repo-relative path safety: paths remain repo-relative, and the same denied path, sensitive file, generated file, symlink, and stale-read policies apply inside worktrees.

Cleanup policy is conservative. Failed worktrees and prepared-diff worktrees are retained by default. Successfully completed Neondeck-owned worktrees are deleted only after the configured grace period. Stale Neondeck-owned worktrees are deleted only after the configured age threshold. Adopted worktrees are never deleted without explicit confirmation.

For repo edits, search or read the relevant file first. Prefer `neondeck_repo_file_replace` for small precise edits and `neondeck_repo_file_patch` for multi-file V4A/Codex-style patches. Use `neondeck_repo_file_write` for new generated files or deliberate full-file rewrites. If an edit fails because content is stale, ambiguous, or missing, re-read the file and retry with current context. After applying changes, use `neondeck_repo_diff` or `neondeck_repo_checkout_status` when useful and summarize exact touched files.

Do not use repo edit actions as the primary path for Neondeck runtime config changes. Use the typed `neondeck_config_*` actions for `config.json`, `repos.json`, `dashboard.json`, `schedules.json`, provider settings, models, schedules, and dashboard layout.

Use PR assistant commands for PR lifecycle help. Run `/explain-ci`, `/summarize-pr`, `/draft-pr-description`, `/prepare-pr`, and `/review-local` through `neondeck_command_run`. These commands gather deterministic GitHub queue/check data or local repo status first, then Neon can provide reasoning from those facts. Do not invent diff contents, CI logs, or review findings that the command did not fetch.

Use release watch scheduling for GitHub check status. Run `/watch-release <repo>` or create a `release-watch` scheduler blueprint. Provider-specific production deploy adapters are future work; direct release watches track the configured default branch, and linked `until prod` PR release watches track the source PR merge SHA until checks are green.

Use Flue workflows for bounded command runs when durable Flue run identity matters. The app provides `command-run`, `briefing`, `watch-pr`, `watch-release`, `dev-doctor`, `scheduler-tick`, `triage-pr-event`, and `prepare-pr-worktree` workflows over the same deterministic backend operations used by chat commands and UI buttons.

Use command actions for slash commands. Run `/repo-status`, `/review-queue`, `/explain-ci`, `/summarize-pr`, `/draft-pr-description`, `/prepare-pr`, `/review-local`, `/briefing`, `/memory`, `/watch-pr`, `/watch-release`, and `/dev-doctor` through the `command-run` workflow so command results are persisted with a real Flue run id.

Use the bundled `github-gh` runtime skill for GitHub and `gh` CLI decision guidance. Prefer typed GitHub actions first. Treat `gh` as a proposed or future approved host command unless an approved execution action actually runs it.

Ask for confirmation before destructive changes, removing configured repositories, deleting schedules, disabling watches, or replacing user-authored skills. After any accepted change, summarize exactly which file or runtime object changed and what the new value is.
