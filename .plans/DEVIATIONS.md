# Deviations Log

Track meaningful implementation deviations and deferrals from `.plans/ROADMAP.md`.

This file is important for progress tracking and reviews. Update it whenever an implementation changes scope, ordering, technical approach, or defers planned work.

Use this format:

```markdown
## YYYY-MM-DD - Roadmap Item Name

- Roadmap item: Phase N / item name
- Decision: What changed from the roadmap.
- Reason: Why the change was necessary or preferable.
- Follow-up: What remains, who/what should handle it, or `None`.
```

## 2026-06-27 - Neondeck Home And Runtime State

- Roadmap item: Phase 1 / Neondeck home and runtime state
- Decision: Landed runtime-home resolution, initial config/data/skill layout, config-file validation, and separate app/Flue SQLite files, but deferred typed config mutation actions and a fuller runtime config/status API.
- Reason: Typed config actions are Phase 2 self-configuration work, and the Phase 1 slice only needed enough API surface for dashboard config reads and runtime bootstrap.
- Follow-up: Phase 2 added the initial config actions. A richer runtime status/config API remains for a later dashboard/API pass.

## 2026-06-27 - Flue Actions For Self-Configuration

- Roadmap item: Phase 2 / Flue actions for self-configuration
- Decision: Landed deterministic Valibot-backed Flue actions for config read, validate, reload, repo add/update/remove, and schedule add/update/remove. The reload action validates and returns the active disk-backed config snapshot rather than restarting the process or pushing live UI notifications.
- Reason: Current runtime config reads are disk-backed, so no in-process cache needs invalidation yet. Restart semantics and live notification fanout should wait until the dashboard has a richer runtime state/event API.
- Follow-up: Add explicit runtime status/config HTTP endpoints and event fanout when dashboard panels move to runtime state in Phase 6.

## 2026-06-27 - Repo Registry And GitHub Foundation

- Roadmap item: Phase 3 / Repo registry and GitHub foundation
- Decision: Landed a validated repo registry snapshot API and made the GitHub PR queue include configured repositories from `repos.json`. Deferred CI/check status enrichment, GitHub workflow actions, and full work-queue triage.
- Reason: The first Phase 3 slice establishes the shared registry-backed data source for dashboard panels, future workflows, and watchers without pulling in the broader triage/checks surface.
- Follow-up: Add structured GitHub actions for PR/check details, enrich PR results with CI status, and build the work-queue triage workflow.

## 2026-06-27 - Schedules, Watches, And Blueprint-Style Automations

- Roadmap item: Phase 4 / schedules, watches, and blueprint-style automations
- Decision: Landed durable app tables for watches, jobs, notifications, memories, and workflow summaries; deterministic `neondeck_watch_pr_*` actions; GitHub check-run status enrichment for merged PR watches; blueprint-backed schedule creation; a local scheduler loop; active watch/job/notification APIs; and quiet `silent` refresh results for unchanged watches. The later Flue alignment pass changed morning briefing and review queue digest scheduler jobs from app-only summary placeholders into admissions of real Flue workflows with run ids recorded in job results and notifications. Production/deploy status watching remains a provider-specific follow-up.
- Reason: Phase 4 needs the local scheduler and deterministic watch substrate first. Deploy status adapters depend on configured deployment providers. The Flue alignment pass kept scheduling deterministic while using Flue workflow runs for bounded scheduled work.
- Follow-up: Add deploy-provider status adapters when repo deploy targets are formalized, and build richer dashboard inspection over scheduled Flue run history.

## 2026-06-27 - Runtime Skills

- Roadmap item: Phase 5 / runtime skills
- Decision: Landed Neondeck-managed runtime skill discovery from `skills/` and configured `skillRoots`, folder validation with ignored-entry reporting, metadata and full-load APIs, Flue actions/tools for list/load/reload, duplicate-id detection, and automatic registration of active runtime skills as Flue `defineSkill` references when the display assistant initializes. The built-in Neondeck guidance moved out of mutable runtime home seeding and into an application-owned Flue skill at `src/skills/neondeck/SKILL.md`. Runtime skill resources are bounded to trusted, non-sensitive, non-symlink files with size and binary handling limits. The reload action rescans disk for APIs/actions, but active Flue sessions keep their existing skill context.
- Reason: Flue skills are the idiomatic mechanic for procedural guidance. Mutable `NEONDECK_HOME` skills still need app-owned discovery and validation, but they should enter the agent as Flue skills rather than prompt-injected text. Existing session context should stay stable rather than being rewritten under an active conversation.
- Follow-up: Add session-level skill context refresh if Flue exposes a safe active-session update hook or when Neon command/session management lands.

## 2026-06-27 - Neon Commands And Workflows

- Roadmap item: Phase 6 / Neon commands and workflows
- Decision: Landed slash command parsing, deterministic command workflow execution for `/repo-status`, `/review-queue`, `/briefing`, and `/watch-pr`, persisted `workflow_summaries`, Flue command actions, dashboard command buttons in the chat panel, and Flue `defineWorkflow` wrappers for command-run, briefing, watch-pr, watch-release, dev-doctor, and scheduler-tick. The later Flue alignment pass removed the legacy app-only `/api/commands/run` path, moved dashboard command buttons to the Flue workflow endpoint, exported run inspection middleware for user-facing workflows, attached Flue run ids to workflow summaries through `observe()`, and guarded local Flue routes by loopback host plus browser origin checks.
- Reason: The roadmap calls for one backend command/event surface shared by chat and UI buttons. Routing UI-triggered commands through Flue workflows gives bounded operations Flue run identity/history without splitting command semantics.
- Follow-up: Build richer dashboard workflow observation with `@flue/react`/SDK when the workflow dashboard matures, and promote commands that need long-running agent reasoning into richer first-class Flue workflows.

## 2026-06-27 - Release Watch

- Roadmap item: Phase 10 / release watch
- Decision: Landed `/watch-release`, release-watch scheduler execution, and `until prod` PR watch linkage. Direct release watches poll configured default-branch GitHub checks, while linked `until prod` PR release watches poll the source PR merge SHA. Provider-specific production/deploy adapters remain deferred.
- Reason: The roadmap explicitly marks provider-specific deploy adapters as later work. GitHub checks give a deterministic release watch now while keeping deployment-provider integration separate.
- Follow-up: Add provider adapters for configured `productionTarget` values when deploy providers are selected.

## 2026-06-27 - Flue Idiomatic Runtime Alignment

- Roadmap item: Phase 5 / runtime skills, Phase 6 / Neon commands and workflows, Phase 8 / subagents, and cross-cutting Flue architecture cleanup
- Decision: Reworked the display assistant toward Flue-native primitives: built-in Neondeck guidance is now an app-owned Flue skill, runtime skills are registered as Flue `defineSkill` references with bounded trusted-resource loading, simple deterministic fact reads are exposed as `defineTool` lookup tools, longer command/dev-doctor/scheduler work emits structured `emitData` progress and `log` events, command buttons call Flue workflows directly, scheduler jobs admit real Flue workflows where available, workflow summaries retain Flue run ids, and app-level `observe()` now records failed Flue work as Neondeck notifications. Added named Flue subagent profiles for repo research, CI investigation, and release review, with display-assistant and subagent model selection configurable from runtime-home `config.json` and mutable through the typed `neondeck_config_update_agent_models` action. Also made the agent sandbox policy explicit by keeping the default virtual sandbox rooted at `/workspace` and routing host state through bounded tools/actions. This entry also records the initial remediation fixes from the Flue review: removing prompt-injected runtime skill instructions, removing the legacy command-run API path, exposing workflow run inspection, hardening local Flue route access, and filtering runtime skill resources.
- Reason: The previous runtime skill and command paths mixed prompt injection, app-only command APIs, and deterministic facts as model actions. Flue provides first-class skills, tools, workflows, subagents, action telemetry, and observation hooks, so aligning with those primitives makes Neondeck a better Flue example and keeps host access bounded.
- Follow-up: Build richer dashboard views over Flue run/event streams, add runtime provider registration only after credentials and allowed endpoint validation are designed, and revisit active-session skill refresh only if Flue exposes a safe session update mechanism.

## 2026-06-27 - Runtime Readiness, Review Queue Triage, And Structured Memory

- Roadmap item: Phase 8 / runtime dashboard state, Phase 11 / work queue triage and PR assistant, Phase 12 / structured memory
- Decision: Added a deterministic runtime status API/tool and dashboard readiness panel covering home paths, credentials, model/provider config, repo/schedule/watch/skill counts, database state, and recent Flue failures. Promoted `/review-queue` into a triage summary with authored/assigned/review-requested PRs, failed or unknown checks, stale PR coverage, active watches, top actions, paginated GitHub search, partial-result metadata, commit status contexts, and compact persisted summaries. Added durable structured memory actions/API/tooling for user, project, session, and watch scopes, plus new-session memory instructions loaded into the display assistant. Folded memory and partial runtime data into the Runtime Overview panel.
- Reason: These items are prerequisites for making Neon understandable and useful: users need to know whether it is ready, why GitHub/Flue data may be partial, what work needs attention first, and which durable preferences/context are currently available to new sessions.
- Follow-up: Broaden compact/redacted workflow summary contracts beyond `/review-queue`, tighten model-visible tool/action output schemas, add richer Flue run/event inspection in the dashboard, and continue the remaining PR assistant command workflows.

## 2026-06-27 - Workflow Run Observability

- Roadmap item: Phase 8 / workflow observability
- Decision: Added a sanitized `workflow_events` app-state table, `observe(...)` recording for run lifecycle, data, log, tool, turn, and operation events, a `/api/workflows/observability` endpoint, Runtime Overview sections for active runs, failed runs, progress data, and action/tool logs, and run-detail links to the guarded Flue `/api/flue/runs/:runId?meta` inspection route. Exported `runs` middleware from first-party workflows so those links resolve consistently.
- Reason: Flue run inspection can expose raw inputs, outputs, prompts, and tool data. Persisting compact event summaries gives the dashboard useful operational visibility without making raw run payloads the default UI surface.
- Follow-up: Add a dedicated workflow observability panel or drilldown view when the dashboard layout is expanded, and continue tightening model-visible schemas for observability tools/actions.

## 2026-06-27 - Provider And Model Config UX

- Roadmap item: Phase 13 / provider configuration and safety
- Decision: Added a strict allowlisted provider config schema for `kilocode`, typed read/update provider actions, `/api/providers` and `/api/providers/kilocode` routes, `/api/models` over the existing model action, readiness details for provider env refs, and Runtime Overview controls for display-assistant/subagent model strings plus Kilo provider environment variable references. Provider config stores env var names only, rejects raw secret-looking strings through env-var-name validation, rejects unknown provider ids and raw provider fields, and skips Kilo provider registration on restart when `enabled` is false. Model config mutations now require provider-qualified strings that use registered Neondeck providers.
- Reason: Users need a visible and auditable way to configure models and provider credentials without turning Neondeck into arbitrary base-url-plus-secret editing. Keeping provider config allowlisted preserves deterministic Flue provider registration and matches the current safety boundary.
- Follow-up: Add richer provider-specific setup docs and consider dynamic provider reload only if Flue exposes a safe provider registration/update mechanism.

## 2026-06-27 - Notification Attention Policy

- Roadmap item: Phase 14 / usability hardening and notifications that matter
- Decision: Added durable notification reconciliation by `source` and `sourceId`, occurrence counts, `updated_at`, `resolved_at`, active-by-default notification listing, read and resolve API routes, a policy description in the notifications API, Runtime Overview notification controls, and readiness filtering that ignores resolved Flue notifications. Existing scheduler and watcher notification producers now get dedupe/reconcile behavior through the shared `addNotification` helper.
- Reason: Watchers, scheduler jobs, and Flue observations can repeatedly report the same operational condition. Reconciling unresolved notifications keeps the side-display signal glanceable while preserving how many times the condition recurred.
- Follow-up: Add optional desktop/audio delivery hooks after the local attention policy is stable.

## 2026-06-27 - Session Lifecycle Management

- Roadmap item: Phase 14 / session lifecycle
- Decision: Added durable Neon display-assistant session metadata in app SQLite, default active session bootstrap, duplicate-active-session recovery, session status/start Flue actions, read-only session status tool, `/api/session` and `/api/session/new` routes, runtime readiness session context checks, and dashboard chat controls for starting a fresh session. Stale-context detection compares the active session activation time against config history and structured memory event writes, including memory deletes. The dashboard now switches chat to the runtime-owned active Flue agent session id instead of relying only on static dashboard config.
- Reason: Model, provider, skill, and memory changes should not silently mutate an active prompt context. A fresh Flue agent session id is the safest current way to load changed SOUL, skills, model config, and memory instructions deliberately.
- Follow-up: Add explicit skill-file change tracking if runtime skill edits should mark sessions stale before a manual skill reload, and revisit context refresh if Flue exposes a safe active-session refresh mechanism.

## 2026-06-27 - PR Assistant Commands

- Roadmap item: Phase 11 / real PR assistant commands
- Decision: Added `/explain-ci`, `/summarize-pr`, `/draft-pr-description`, `/prepare-pr`, and `/review-local` to the existing `command-run` Flue workflow and persisted command summary path. The commands gather deterministic GitHub PR queue/check data, local repo status, or local diff metadata first, return structured facts plus assistant briefs, and expose dashboard quick buttons. They do not mutate GitHub, run host validation, or infer semantic diff contents beyond fetched repo/PR facts.
- Reason: PR assistant behavior should be useful immediately but remain action-mediated and auditable. Routing through the existing Flue command workflow keeps run identity, observations, summaries, and dashboard controls consistent with the rest of Neondeck.
- Follow-up: Add richer diff/check-log ingestion once safety approvals and host execution policies are defined.

## 2026-06-27 - Safety And Approval Policy

- Roadmap item: Phase 14 / safety and approvals
- Decision: Added a deterministic safety policy module, `neondeck_safety_policy_lookup` tool, `/api/safety/policy` endpoint, Runtime Overview safety section, and Neondeck skill/display-assistant guidance for read-only, safe mutation, destructive mutation, and future host-execution classes. The policy now records Flue primitive type across tools, actions, workflows, and key local API routes. Existing repo, schedule, watch, and memory destructive mutations now align around explicit confirmation; memory deletion was tightened to require `confirm=true`, returns a 400 on unconfirmed API deletes, and remains audited through `memory_events`. The app API now applies the same local host and same-origin mutation guard previously used for guarded Flue routes.
- Reason: Before adding shell, local-code, or broader host actions, Neon needs one inspectable policy for which actions can run unattended, which require confirmation, and where durable changes are audited.
- Follow-up: Add an interactive approval request/response flow before implementing any host shell, code-changing, or Flue `local()` sandbox actions.

## 2026-06-27 - Execution Approval Policy

- Roadmap item: Phase 14 / safety and approvals
- Decision: Added config-backed execution approval policy under runtime-home `config.json`, with `local` as the default backend and `exe.dev` accepted as a planned sandbox backend. Added `neondeck_execution_policy_lookup`, `neondeck_execution_policy_check`, and `neondeck_config_update_execution_policy`, plus `/api/execution/policy` and `/api/execution/check`. The policy supports audited preapproved single-command patterns, rejects preapprovals containing shell operators, defaults unattended execution to deny, and keeps a hardline blocklist that cannot be bypassed by config. Runtime status, safety policy, Runtime Overview, README, Astro docs, and the runtime Neondeck skill now describe the policy.
- Reason: Users need local bash/git capability eventually, but Neondeck should establish the approval/config/audit contract before adding an executor. Modeling `exe.dev` now lets the next iteration add sandbox execution without redesigning config.
- Follow-up: Add the actual local and `exe.dev` execution actions only after an approval request/response record is implemented. Executor actions must call `neondeck_execution_policy_check`, write approval/audit records, and never bypass hardline denies.

## 2026-06-27 - Runtime Affordance Panels

- Roadmap item: V1 item 11, item 16, item 23, and Phase 12 / `/memory` plus memory/current-task panel
- Decision: Added an app-owned `github-gh` Flue skill, exposed `/memory` through the existing typed memory actions, added a dedicated briefing panel over persisted command summaries, added a memory/current-task dashboard panel, and added a subagent summary panel that shows configured subagent roles plus recent delegated activity visible through sanitized Flue observations.
- Reason: These affordances make existing runtime state usable without introducing a second command surface or new state store. The subagent panel can be useful now from configured roles and observed Flue activity while preserving the current Flue-owned subagent execution model.
- Follow-up: If Neondeck needs stronger subagent audit guarantees, add an app-owned subagent delegation summary table or explicit workflow wrappers around delegated tasks instead of inferring activity from observations.

## 2026-06-28 - Approved Host Execution And exe.dev Sandbox

- Roadmap item: Phase 14 / approved host execution and exe.dev sandbox
- Decision: Added model-callable `neondeck_execution_request_approval` and `neondeck_execution_run`, dashboard/API-owned approval resolution, plus the `execution_approvals` audit table, API routes, Runtime Overview approval controls, tests, and docs. Local execution is an app-owned single-command `execFile` executor. `exe.dev` execution uses the Flue `sandbox/exedev` blueprint adapter and Flue `SessionEnv.exec`, but only for an existing VM referenced by environment variable.
- Reason: The immediate usability need is approved local bash/git and a Flue-aligned exe.dev adapter without giving the model an unrestricted host shell. Existing-VM exe.dev support proves the adapter path while avoiding premature lifecycle choices around per-execution, per-session, per-repo, or user-selected VM reuse.
- Follow-up: Add application-owned exe.dev create/clone/delete orchestration and credential scoping for lifecycle modes, then revisit whether Flue `local()` should back any broader local sandbox mode beyond the current single-command approved executor.

## 2026-06-28 - Dedicated Workflow Observability Panel

- Roadmap item: Phase 15 / workflow observability drilldown
- Decision: Added a first-class `workflow-observability` dashboard plugin, seeded it into the default middle runtime column, and kept raw Flue run inspection behind explicit per-row `inspect` links. The panel filters active runs, failed runs, progress data, and action/tool/operation activity over the existing sanitized workflow observability API.
- Reason: Runtime Overview already surfaced workflow facts inline and was becoming crowded. A dedicated panel makes Flue workflow state easier to inspect while preserving compact/redacted summaries as the default surface.
- Follow-up: None.

## 2026-06-28 - Config Event Fanout

- Roadmap item: Phase 1 and Phase 2 / live config-change event fanout
- Decision: Added an app-owned `/api/events/config` server-sent event stream for audited config writes and explicit `config_reload` events, plus dashboard listeners that refresh affected UI surfaces without a browser reload.
- Reason: Config writes already flow through `config_history`, but manual config file edits followed by reload do not create history rows. Emitting reload events keeps the dashboard current for both typed action mutations and explicit reload workflows.
- Follow-up: None.

## 2026-06-28 - Dashboard Layout Schema And Actions

- Roadmap item: Phase 2 / config management actions and Phase 6 / dashboard panels driven by runtime state
- Decision: Replaced one-plugin-per-region dashboard config with a statusline plus tabbed region stacks, added `dashboard.schema.json`, and added `neondeck_config_apply_dashboard_preset` plus `neondeck_config_update_dashboard_layout` so Neon can configure layouts through typed actions.
- Reason: The Xeneon layout needs to preserve the original left-work/right-Neon geometry while exposing secondary panels without crowding the screen. The app has not shipped yet, so dropping the older dashboard config shape is simpler than maintaining compatibility.
- Follow-up: None.

## 2026-06-28 - Repo Editing Core

- Roadmap item: Repo Editing Plan / Phases 1-7
- Decision: Landed the core repo-editing substrate, Valibot-backed Flue actions, local HTTP APIs, SQLite audit/read-stamp tables, runtime skill guidance, CLI `repo diff` and `edit-events` commands, Runtime Overview repo edit event visibility, path/workspace policy, stale-read protection, fuzzy replacement, V4A patch parsing, staged multi-file patch writes, and Git diff/status helpers. Deferred a dedicated diff-preview/edit-events dashboard panel, cleanup jobs for old read stamps/audit rows, and richer generated-file detection knobs.
- Reason: The frequent-agent-use path needs deterministic actions and hard file safety first. Runtime Overview now exposes the audit trail, while a dedicated diff preview panel and cleanup policy should be designed with the broader runtime observability UI instead of rushed into the core edit layer.
- Follow-up: Add a first-class dashboard repo edit diff preview panel, retention cleanup for `repo_file_reads` and capped edit events, and configurable generated-file/sensitive-file markers.

## 2026-06-29 - Provider Expansion And Thinking Levels

- Roadmap item: Phase 13 / provider configuration and safety
- Decision: Expanded allowlisted model providers from KiloCode-only to KiloCode, OpenAI, and Anthropic. OpenAI and Anthropic use Flue built-in providers and runtime `.env` credentials; KiloCode remains the custom registered provider. Added runtime config support for Flue `thinkingLevel` on the display assistant and subagent roles, surfaced thinking controls in Runtime Overview, and added KiloCode model discovery/search during first-run onboarding with manual fallback.
- Reason: Users should be able to choose common Flue built-in providers without arbitrary endpoint editing, and reasoning effort is a first-class Flue model setting. KiloCode model search improves onboarding while keeping provider registration deterministic and allowlisted.
- Follow-up: Consider a richer server-side model catalog API for dashboard model search if model browsing becomes useful outside first-run setup.

## 2026-06-30 - Chat Session Index And Switcher

- Roadmap item: Phase 16 / Chat session index and switcher
- Decision: Added the app-owned `chat_sessions`, `chat_session_surfaces`, and `chat_session_audit` tables; migrated legacy `neon_sessions` rows; added deterministic Valibot-backed session list/search/read/messages/create/switch/rename/pin/archive/restore/link-context actions and lookup tools; added local APIs and session-change SSE; and updated the dashboard chat panel with pinned, recent, and archived session selection plus create, rename, pin, archive, and restore controls. `neondeck_session_messages` currently audits transcript-read intent and returns metadata with `transcriptUnavailable: true` instead of paging raw messages.
- Reason: The roadmap explicitly keeps Flue as the owner of `display-assistant/:id` conversation history and there was no stable local Flue transcript-read API available in this worktree beyond the existing React agent hook. Returning an audited metadata-only response preserves that ownership boundary and avoids copying transcripts into Neondeck app state.
- Follow-up: Add real transcript paging only through a supported Flue read API, generate/refresh session summaries from bounded Flue-owned transcript reads, add first-class "reference this session" UI affordances from repo/watch/workflow rows, and reuse these APIs from the future TUI surface.
