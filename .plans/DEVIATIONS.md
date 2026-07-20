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

## 2026-07-20 - Minimal Autopilot Owner Archival

- Roadmap item: Phase 19 / Autopilot Simplification PR 2 complete minimal loop
- Decision: Treat a terminal watch's `complete` state as the owner archive boundary: polling and direct owner messages stop, eligible Neondeck-created worktrees are cleaned through the existing cleanup policy, and the Flue conversation is retained unchanged as the audit trail. No duplicate session row or transcript lifecycle table is created solely to label the private owner archived.
- Reason: The installed Flue runtime exposes durable continuing conversations and abort/settlement, but no separate archive mutation for an agent instance. Adding a second app-owned archive record would recreate lifecycle machinery without changing whether the owner can run or whether its audit history is retained.
- Follow-up: None unless Flue adds a native agent-instance archive operation; the watch remains the single lifecycle owner.

## 2026-07-20 - Autopilot Coordinator Reset

- Roadmap item: Phase 19 / PR event Autopilot reset
- Decision: Forward-delete the abandoned admission/coordinator runtime while preserving complete GitHub feedback fingerprints, exact-head worktrees, bounded Git behavior, generic watches and worktrees, the diff viewer, readiness facts, and reusable private owner/Flue seams. Keep every historical migration already on `main` and add one generated forward cleanup migration that removes the abandoned tables and watch generation column from upgraded runtime homes.
- Reason: The Package 1–4 migrations are already in the shipped `main` history and were not proven unshipped, so rewriting them would make upgrades unsafe. The coordinator also duplicated workflow-engine responsibilities and is explicitly superseded by `.plans/AUTOPILOT_IMPLEMENTATION_PLAN.md`.
- Follow-up: Implement the replacement minimal loop in PR 2 only after this reset is reviewed and merged. Do not restore admissions, stage ledgers, owner generations, grounding snapshots, queues/coalescing, submission leases, or workflow-observation continuation.

## 2026-07-19 - Kilo Reconciliation Fixture Process Inspection

- Roadmap item: Phase 21 / Kilo task retention and reconciliation
- Decision: Keep production reconciliation's OS process inspection unchanged, but make the persisted-running-task test provide a narrowly controlled `ps` snapshot for its manually spawned fake Kilo process and wait for every forcibly terminated fixture child before deleting the temporary runtime home.
- Reason: The test sandbox permits liveness checks but denies Node's `ps` spawn with `EPERM`, so the real reconciler correctly records `process-command-unavailable` and admits fresh work. The prior fixture therefore could not represent a persisted process whose command matched its recorded Kilo context; its teardown could also remove SQLite before a child exit handler settled.
- Follow-up: None. Production deployments must continue to use real `ps` command inspection; this test-only snapshot is scoped to the sandbox-constrained fixture.

## 2026-07-18 - Diff Review Phase B Completion Audit

- Roadmap item: Diff Improvements Plan / Phase B guided review completion audit
- Decision: Mark Phase B complete after independently reconciling the shared contracts and all three live review surfaces. Correct the one bounded gap found by keeping the applied prepared-diff review and its approval/recovery context mounted when a background metadata refresh fails, while showing the refresh error. Stop implementation at Phase B; do not start Phases C–E.
- Reason: The merged source/revision, navigation, finding, promotion, and refresh work satisfies the Phase B acceptance criteria, but the prepared surface's unconditional refresh-error return violated the availability-versus-application contract even though the Kilo surface already preserved applied data.
- Follow-up: Phases C–E remain later work exactly as recorded in `.plans/DIFF_IMPROVEMENTS_PLAN.md`.

## 2026-07-18 - Worktree Fingerprint Poll Content Bound

- Roadmap item: Diff Improvements Plan / Phase B revision-aware live refresh performance
- Decision: Describe the 30-second prepared/Kilo fingerprint poll as cadence- and query-scope-bounded only. Retain the current full-content hashing in `gitWorktreeRevision`; do not add caching or a hard byte/time bound during this audit.
- Reason: The poll does not load patch bodies, but it hashes every changed regular file in full and is therefore byte- and time-unbounded for pathological huge changed files. Changing that behavior affects revision identity and freshness guarantees and requires lead/user discussion rather than a risky audit-time optimization.
- Follow-up: Discuss fingerprint caching or explicit byte/time policy before implementation; until then, retain this as a known deferred performance limitation and do not claim byte-bounded content work.

## 2026-07-18 - Diff Review Performance Reconciliation

- Roadmap item: Diff Improvements Plan / transition from Phase A to Phase B
- Decision: Mark the specialized PR review performance plan complete for now and unpause Phase B while explicitly deferring the production tree median (642 ms versus <500 ms), one-time cold local object fetch (4,978 ms versus <3,000 ms), and uncached review-thread surface/read latency (1,511 ms surface and 655 ms initial GitHub-backed read versus the warm path's <500 ms target). Retain the specialized plan in place instead of archiving it while those measured misses remain.
- Reason: Stable query identity, bounded immutable metadata reuse, active-patch prioritization, and bounded warm thread reuse delivered passing warm first-patch and thread medians and removed duplicate/abandoned work. The remaining misses are measured, isolated follow-ups that do not require overlapping changes in the Phase B review-map/cursor seam, but they must not be represented as passing or erased.
- Follow-up: Reprofile the production tree boot/query/render boundary; separate cold network object-fetch time from local metadata before changing refspecs or the <3-second budget; and evaluate uncached GitHub thread latency without weakening cancellation or mutation invalidation. Remeasure the retained immutable real PR before changing any budget, then archive `.plans/PR_REVIEW_PERF_PLAN.md` only after these deferrals are reconciled.

## 2026-07-18 - Diff Review Phase B Finding Backend Split

- Roadmap item: Diff Improvements Plan / Phase B typed Neon finding application and inline rendering
- Decision: Land the versioned finding contract, process-ephemeral review-surface state, bounded local APIs, targeted events, and Flue tools/actions separately from Pierre/React rendering and explicit promotion into GitHub drafts or prepared-diff revision requests. The shared lifecycle vocabulary includes `resolved` and `promoted`, but this backend slice exposes only apply, read, dismiss, clear, automatic staling, and cleanup transitions.
- Reason: Diff Improvements Phase B is split across parallel backend and review-UI workstreams. Keeping promotion out of the finding application path preserves the trust boundary that applying local context cannot mutate GitHub or prepared diffs.
- Follow-up: The review-surface UI workstream should render these findings inline, add navigation and explicit user-owned promotion controls, and transition resolved/promoted lifecycle state only through the existing typed GitHub draft and prepared-diff revision workflows.

## 2026-07-17 - Diff Review Phase A Sequencing

- Roadmap item: Diff Improvements Plan / transition from Phase A to Phase B
- Decision: Retain the completed Phase A implementation in PR #143, pause Phase B, and resume the specialized PR review performance workstream before advancing the broader diff roadmap.
- Reason: Phase A was implemented before `.plans/PR_REVIEW_PERF_PLAN.md` reached full acceptance. The first-patch and warm backend targets pass, but production tree visibility, review-thread visibility, and the one-time cold-object fetch still miss their retained budgets and were not explicitly deferred as a group.
- Follow-up: Investigate review-thread latency first, then reconcile tree visibility and separate cold network-fetch time from local metadata time. Advance to Phase B only after the remaining misses pass or are explicitly deferred with recorded rationale.

## 2026-07-06 - Learning Flywheel Wrap-Up

- Roadmap item: Wrap Up the Learning Flywheel / memories in, health out, triggers verified
- Decision: Routed bounded active learning memories into `/review-pr`, `/fix-ci`, docs-drift fix staging, and repo-scoped routines, with included memory ids recorded in workflow summaries or routine run summaries. Added an automation-health read model and surfaced it in hygiene reports plus PR retrospective evidence. PR retrospectives now load runtime skill snippets by evidence relevance instead of always loading all five busywork skills. Verified the existing applied skill-patch restore path already performs an audited rollback from retained before/after content. Routine settlement observations now count toward conversation learning cadence because unattended routine sessions generate assistant turns worth reflecting on.
- Reason: Approved memories were not measurable in the automation loop, and retrospectives needed aggregate health next to per-event evidence. The existing skill-patch restore action already matched the rollback requirement, so no replacement action was needed. Routines bypass the HTTP chat middleware, so they needed explicit turn accounting from matched routine observations.
- Follow-up: Keep `learning.prRetrospectiveThreshold`, `learning.conversationReviewTurnInterval`, and `learning.memoryCurationTurnInterval` at their configured defaults until dogfooding data shows over- or under-triggering. `/review-pr` preparation is deliberately not counted as a `pr_handled` terminal outcome because it prepares local reports/draft comments rather than resolving PR work; submitted review seed outcomes still flow through automation health. Issue-triage acted-on rate remains zero/unavailable until issue triage has a typed user action comparable to docs-drift stage-fix.

## 2026-07-06 - Busywork Automation Trust Boundaries

- Roadmap item: Busywork Automation Plan / `/fix-ci` and issue triage
- Decision: `/fix-ci` stops before Kilo when failing check logs are unavailable or truncated, even when check-run identity and annotations were fetched. Issue triage v1 writes deterministic copy-ready draft replies into reports instead of launching a nested agent digest from inside the scheduler job.
- Reason: Partial CI logs can make Kilo repair the wrong failure mode, and the scheduler currently owns durable job state. Keeping issue-triage drafts deterministic avoids nested workflow/job-state coupling while still producing human-owned copyable replies.
- Follow-up: Revisit partial-log CI handoff once the dossier can distinguish providers with complete annotations from providers that require logs. Replace deterministic issue-triage drafts with a bounded Flue digest workflow when scheduler job state can safely record nested workflow outcomes.

## 2026-07-06 - Busywork And Routines Workflow Hosts

- Roadmap item: Busywork Automation Plan and Routines Plan / Flue workflow execution
- Decision: Added dedicated `pr-review-assistant`, `busywork-workflow`, and `scheduler-workflow` agents even though the plans preferred no new general-purpose agents.
- Reason: These are zero-capability workflow hosts (`tools: []`, `actions: []`, `subagents: []`) that provide bounded workflows with model execution plus patchable runtime skills without exposing the display assistant's broader action surface to unattended runs.
- Follow-up: Do not collapse these hosts back onto the display assistant unless the replacement preserves the same no-tool/no-action/no-subagent boundary.

## 2026-07-05 - Close Decision Loops Run Revision

- Roadmap item: Close Decision Loops Plan / PR 1 run revision
- Decision: Implemented the revision-run orchestration in `src/modules/autopilot/revision-run.ts` and the Kilo terminal reconcile hook in `src/modules/kilo/revision-reconcile.ts` instead of placing the whole service under `src/modules/prepared-diffs/revision-run.ts`.
- Reason: The repo import-layer check keeps `prepared-diffs` at backend layer 2 and forbids it from depending upward on Kilo. Autopilot is the correct orchestration layer for the human-triggered dispatch; Kilo owns terminal task observations; prepared-diffs remains the lower-level state surface.
- Follow-up: None.

## 2026-07-04 - MCP Support Core

- Roadmap item: MCP Support Plan / PR 1 MCP core
- Decision: Implemented the core MCP config, registry, gated tool, CLI, chat/action, route, status, safety, and fixture-test surface in one commit-sized slice, but used a direct SDK-backed adapter for executable MCP tools instead of wrapping Flue beta.9's `connectMcpServer` tool definitions.
- Reason: The installed Flue beta.9 remote MCP adapter stores execution in an internal prepared-tool adapter. A normal `ToolDefinition.run` wrapper either preserves that internal adapter and bypasses Neondeck's approval gate, or drops it and leaves the returned MCP tool's `run()` throwing. The direct SDK adapter mirrors Flue's `mcp__<server>__<tool>` naming and result formatting while letting Neondeck enforce approval before execution.
- Follow-up: Revisit the registry adapter when Flue exposes a public MCP tool-call interception hook, stdio support, or a wrappable MCP adapter that preserves gating semantics.

## 2026-07-04 - MCP OAuth And Agent Safety Boundary

- Roadmap item: MCP Support Plan / PR 2 OAuth + dashboard surfacing
- Decision: Implemented OAuth storage/login/callback/logout, Runtime Overview MCP server and approval UI, docs, CLI/API routes, and review hardening. Narrowed model-callable MCP actions so Neon cannot add/connect stdio servers, configure header-authenticated servers, set auto-approval policy, or resolve MCP tool-call approvals itself. Server mutation remains available from user-owned CLI, API, and direct config surfaces; dashboard surfaces OAuth login/logout and approval decisions.
- Reason: Stdio MCP config can spawn host processes, header auth can forward environment-backed secrets, auto-approval changes safety policy, and model-callable approval resolution would let the same agent approve and retry its own third-party tool call. Keeping these behind user-owned surfaces preserves the plan's deterministic runtime while avoiding a self-approval or execution-policy bypass.
- Follow-up: If Neondeck later adds signed user-intent tokens for chat-mediated approvals, reintroduce chat approval resolution with a non-model authorization proof. Revisit native Flue MCP schema adaptation when Flue exposes public JSON Schema or interception hooks.

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
- Status: superseded by the 2026-07-10 scheduler refactor. Blueprint/raw-
  schedule terminology is historical only; current scheduling uses typed SQLite
  scheduled tasks for PR-watch polling, briefings, and agent instructions.
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

## 2026-06-29 - Utility Model Role

- Roadmap item: Usability Gate / typed configuration for display assistant, utility, and subagent models
- Decision: Added the optional `models.utility` and `models.utilityThinkingLevel` config fields, typed update support, readiness/dashboard/setup/docs visibility, and a minimal session-title helper that reports the utility model role used. If utility is omitted, Neondeck falls back to the display assistant and reports a recommendation instead of failing readiness.
- Reason: The roadmap calls for a named low-cost role, but the current Flue integration in this worktree does not expose an installed local model-call API to verify. Keeping the first concrete use as a bounded helper path avoids introducing an unverified persistent utility agent session.
- Follow-up: Replace the deterministic title compaction inside the utility helper with an actual one-shot Flue model call if/when a verified non-session model invocation API is available locally.

## 2026-06-30 - Chat Session Index And Switcher

- Roadmap item: Phase 16 / Chat session index and switcher
- Decision: Added the app-owned `chat_sessions`, `chat_session_surfaces`, and `chat_session_audit` tables; migrated legacy `neon_sessions` rows; added deterministic Valibot-backed session list/search/read/messages/create/switch/rename/pin/archive/restore/link-context actions and lookup tools; added local APIs and session-change SSE; and updated the dashboard chat panel with pinned, recent, and archived session selection plus create, rename, pin, archive, and restore controls. `neondeck_session_messages` currently audits transcript-read intent and returns metadata with `transcriptUnavailable: true` instead of paging raw messages.
- Reason: The roadmap explicitly keeps Flue as the owner of `display-assistant/:id` conversation history and there was no stable local Flue transcript-read API available in this worktree beyond the existing React agent hook. Returning an audited metadata-only response preserves that ownership boundary and avoids copying transcripts into Neondeck app state.
- Follow-up: Add real transcript paging only through a supported Flue read API, generate/refresh session summaries from bounded Flue-owned transcript reads, add first-class "reference this session" UI affordances from repo/watch/workflow rows, and reuse these APIs from the future TUI surface.

## 2026-06-30 - Session Summaries And Cross-Session References

- Roadmap item: Phase 16 / session summaries and cross-session reference UX
- Decision: Added summary freshness/source metadata, `neondeck_session_refresh_summary`, `neondeck_session_reference`, local API routes, audited explicit-transcript guards, and web dashboard reference/open-session affordances for chat sessions, repo rows, PR rows, watch rows, briefing/workflow summaries, Kilo task rows, and autopilot queue/prepared/activity rows. Summary refresh currently generates compact metadata summaries or stores explicitly provided summaries; it does not read raw Flue transcript pages.
- Reason: The current Flue integration still does not expose a stable transcript paging adapter in this worktree, and the delegated slice explicitly excluded TUI-specific work. Metadata summaries and links satisfy the cross-session default path while preserving Flue transcript ownership.
- Follow-up: Replace metadata-only generated summaries with transcript-derived summaries once a supported bounded Flue transcript reader is available; add future TUI/OpenTUI controls over the same APIs; add direct session hooks for unsupported provider/deploy adapter rows when those data models exist.

## 2026-06-30 - Worktree Runtime Foundation

- Roadmap item: Phase 18 / Worktree Runtime Foundation
- Decision: Implemented the planned worktree runtime foundation: runtime-home `worktrees/`, repo-local `.neondeck/worktrees` option, app SQLite records/locks/events/cleanup attempts, deterministic `neondeck_worktree_*` actions/tools, repo registry active-worktree links, repo-edit `worktreeId` targeting, cleanup policy config/action, Runtime Overview rows, runtime skill guidance, and focused service tests. No Phase 18 scope deviations were taken.
- Reason: Worktrees are the required isolation boundary for later PR event autopilot and Kilo handoff, but this phase should remain deterministic app state and service plumbing.
- Follow-up: Phase 19 and later should add PR event autopilot workflows, prepared-diff UI/push-back flows, and Kilo handoff orchestration on top of these worktree services.

## 2026-06-30 - Autopilot Queue And Policy Surface

- Roadmap item: Phase 19 / dashboard/TUI autopilot APIs and runtime skill guidance; Phase 20 / repo/watch policy and dashboard decision panel
- Decision: Implemented a read-only operator surface over existing app state rather than new autopilot workflow admission tables. `/api/autopilot/state` and `neondeck_autopilot_state_lookup` derive queue, prepared-diff, explicit autopilot approval, running-check, recent-activity, repo-policy, and watch-policy views from PR watches, worktrees, execution approvals, Flue observations, notifications, `config.json`, and repo metadata. Prepared diffs are represented by `worktrees.lifecycle_status = prepared-diff`, watch overrides live under repo `metadata.autopilot.watchOverrides`, missing autopilot config reports conservative `notify-only`, and older roadmap mode names are normalized to the display modes `prepare-only`, `autofix-with-approval`, and `autofix-push-when-safe`.
- Reason: Phase 19A/19B workflow admission, prepared-diff records, push-back, and GitHub event persistence are parallel/deferred work. A composable read adapter gives the dashboard and Neon a useful surface now without inventing a second agent runtime or preempting those backend contracts.
- Follow-up: Replace placeholder adapters with first-class autopilot queue/admission rows, prepared-diff records and APIs, dedicated push approval flows, workflow smoke tests, recovery actions, and policy enforcement when the Phase 19 workflows and Phase 20 push-back services land.

## 2026-06-30 - Minimal KiloCode Handoff Runner

- Roadmap item: Phase 21 / KiloCode Handoff Runner
- Decision: Landed the CLI MVP as an explicit handoff path: `kilo` app config schema, `kilo_tasks` and `kilo_task_events`, an app-owned `kilo run --format json` supervisor, JSONL event/session capture, root-session recovery through `kilo session list`, typed Kilo actions/tools, minimal `/api/kilo/*` routes, `handoff_to_kilo` and `summarize_kilo_session` workflow wrappers, runtime skill guidance, README docs, and fake-CLI tests. Deferred SDK/server adapters, direct transcript/todo reads, restart reconciliation, child-session tree UI, dashboard panels, notification policy, review/verify/promote flows, and ACP.
- Reason: The requested 21A slice was exploratory and concrete but explicitly excluded PR autopilot, push-back policy, queue UI, and ACP. The local Kilo CLI exposes JSON streaming and session-list search, but stable transcript/todo/diff adapters were not proven in this pass.
- Follow-up: Add restart reconciliation for persisted running tasks, evaluate `kilo serve`/SDK for transcript/todo/children/diff access, add dashboard/TUI panels and notifications, and implement review/verify/promote workflows after the durable task model proves useful.

## 2026-06-30 - Kilo Auto Policy

- Roadmap item: Phase 21 / Kilo CLI MVP command construction
- Decision: Kilo `--auto` is not enabled merely by `draft-fix` mode; the action also requires `allowAuto: true` and `confirmAuto: true`, then applies the configured `autoPolicy`.
- Reason: The roadmap confirmation policy says enabling Kilo `--auto` requires explicit confirmation, and this slice should preserve Kilo as a user-invoked delegated worker rather than a default autonomous runtime.
- Follow-up: If a future repo/workflow policy opts into unattended `--auto`, model that as an audited policy change with visible user controls.

## 2026-06-30 - Autopilot Notification Policy And Recovery Actions

- Roadmap item: Phase 19 / autopilot notification policy and Phase 20 / recovery actions
- Decision: Added deterministic autopilot notification states for review-fix, CI-fix, verify, push-blocked, pushed, comment-result, and unexpected failed workflow outcomes, plus a prepared-diff-centered recovery API/action surface for inspect, retry verify, retry push, retry comment, request revision, abandon, and manual follow-up. Rebase/resync-after-new-commit and cleanup-specific recovery buttons remain separate follow-ups.
- Reason: Prepared-diff records are already the durable source for prepared fixes and push-back gates. Centering recovery on `preparedDiffId` reuses existing workflow, prepared-diff, worktree, execution, GitHub, and safety services without adding a parallel queue model.
- Follow-up: Add first-class rebase/resync recovery and cleanup-specific controls after the worktree sync/cleanup UX is designed, then cover those paths with fixture-driven integration tests.

## 2026-06-30 - exe.dev Checkout Sync

- Roadmap item: Phase 14 / existing-VM exe.dev repo/worktree checkout sync helpers and env forwarding
- Decision: Neondeck-managed worktrees are mirrored onto the existing exe.dev VM as separate Git checkouts at the configured worktree ref/SHA rather than as remote Git worktrees linked to another VM checkout.
- Reason: The current Phase 14 model intentionally avoids owning remote VM lifecycle and long-lived remote repo topology. Independent remote checkouts keep the helper deterministic, work for either base repos or managed worktrees, and let every remote `git` step continue through the existing execution approval/audit path.
- Follow-up: If a later lifecycle mode owns per-repo VM state, revisit whether remote `git worktree` topology provides enough reuse benefit to justify the extra cleanup and locking semantics.

## 2026-06-30 - PR Autofix Push Workflow

- Roadmap item: Phase 19 / `push_pr_autofix` workflow and Phase 20 / push-back recovery actions
- Decision: Added `push_pr_autofix` as a bounded Flue workflow/action and local API over approved prepared-diff records. It pushes only approved, verified, clean committed worktrees when autopilot policy and GitHub branch permission facts allow PR-head push-back. Blocked attempts update prepared-diff/worktree state and notifications while retaining the worktree. Result comments remain owned by `comment_pr_autofix_result`, and force-push support remains deferred.
- Reason: The requested slice explicitly kept PR comments separate unless required by the push action contract, and the roadmap forbids force-push unless a future narrowly scoped repo policy enables it. The current safe default is forward push only with durable blocked-attempt recovery data.
- Follow-up: Rebase/resync and cleanup recovery actions were completed by the 2026-06-30 Phase 20 recovery entry below. Any future force-push policy remains deferred behind explicit repo-level configuration and approval.

## 2026-06-30 - Rebase And Cleanup Recovery Actions

- Roadmap item: Phase 20 / rebase/resync and cleanup-specific recovery actions
- Decision: Added prepared-diff recovery actions for retry-after-new-commit, rebase/resync worktree, and cleanup worktree through the existing `neondeck_autopilot_recovery_run` API/action. Rebase/resync delegates to `neondeck_worktree_sync` with a rebase strategy and resets stale prepared-diff push/verification decisions. Cleanup delegates to `neondeck_worktree_cleanup`, requires confirmation unless it is a dry run, and still observes dirty-worktree, lock, adopted-worktree, and cleanup-policy checks.
- Reason: Prepared diffs and managed worktrees are already the durable source of truth for autopilot recovery. Extending those services keeps mutations deterministic and audited without adding a parallel queue or git runtime.
- Follow-up: None.

## 2026-07-02 - Learning Operator Surfaces

- Roadmap item: Phase 22 / dashboard, API, CLI, audit, and rollback surfaces
- Decision: Implemented a consolidated learning operator read model, local API route, Flue read action/tool, dashboard panel, CLI inspect/decide/restore commands, and explicit skill patch restore from retained audit data. The CLI can inspect reviews/candidates/events and decide candidates, but manual workflow admission remains on the local API/dashboard surfaces for now.
- Reason: The existing CLI is a direct local action/config tool and does not yet have a clean Flue workflow invocation pattern. Keeping workflow admission on the already-validated HTTP/dashboard routes avoids adding a second invocation path while still giving operators CLI coverage for review and decision work.
- Follow-up: Add CLI commands for queuing conversation reflection and PR retrospective workflows if the CLI grows a shared Flue invocation helper.

## 2026-07-02 - Phase 22 V1 Closure

- Roadmap item: Phase 22 / Self-Improvement And Learning
- Decision: Marked Phase 22 complete for v1 after adding fast dashboard/API/CLI adapter coverage and extending handled-PR learning accounting to practical direct local API action routes for autopilot preparation/fixes, prepared-diff verification/push, result comments, recovery actions, and Kilo review/verify/promote decisions. Broader automatic admission beyond Flue workflow observations and typed local action routes is deferred.
- Reason: The remaining broad “production automatic admission” language was too open-ended for v1. Current production PR/autopilot outcomes either flow through Flue workflow observations or these typed local action routes, both of which return structured action results that the existing Valibot-backed extractor can account for idempotently. Provider-specific deploy adapters, future TUI/OpenTUI clients, generic harnesses, and any future non-action mutation paths do not have stable v1 contracts yet.
- Follow-up: When new provider-specific deploy/release adapters or non-Flue automation frontends are added, route their terminal PR outcomes through the same handled-PR accounting helper or a typed successor service.

## 2026-06-30 - Autopilot Smoke And Integration Coverage

- Roadmap item: Phase 19 / autopilot smoke and integration coverage
- Decision: Added an explicit `NEONDECK_AUTOPILOT_FIXTURE_PATH` fixture provider for workflow smoke tests instead of adding caller-supplied PR/check/review facts to model-visible workflow inputs. Outside test runs, the fixture provider also requires `NEONDECK_AUTOPILOT_FIXTURE_ENABLE=1`. The local `smoke:autopilot` script runs a real `flue run workflow:triage-pr-event` routing smoke, then runs the deterministic Vitest workflow smoke suite that exercises all stateful autopilot workflow wrappers with temporary repos, fake GitHub/check/comment/push fixtures, prepared diffs, notifications, workflow summaries, and observability records.
- Reason: Existing production schemas intentionally reject caller-supplied PR facts, and preserving that boundary matters for autopilot safety. Full end-to-end `flue run` coverage for every mutating workflow would require either model-visible fixture inputs or a heavier smoke harness; the validated environment fixture keeps local smoke deterministic and credential-free.
- Follow-up: If Flue exposes a first-class test fixture/injection surface for workflow dependencies, move the stateful workflow smoke runner from direct workflow action wrappers to that surface while keeping production action inputs fact-free.

## 2026-07-01 - Self-Improvement Memory Foundation

- Roadmap item: Phase 22 / Self-Improvement And Learning
- Decision: Landed the memory foundation subset only: active `user`, `local`, and `project` memory writes; legacy `session`/`watch` memory read compatibility; active/archived statuses; audited create/update/rewrite/merge/archive/reject events; learning events/reviews/candidates schema; memory curation config and bounded curation action/workflow; self-improvement model config/fallbacks; prompt snapshot memory-id recording; safety policy entries; and docs. Deferred model-backed conversation reflection, PR/autopilot retrospectives, skill patch propose/apply/reject/rollback actions, a dedicated learning dashboard panel, CLI learning commands, and full learning review orchestration.
- Reason: The requested PR scope was the core memory side of Phase 22 as a focused PR. Implementing skill patching, reflection agents, PR retrospective triggers, and full dashboard/CLI surfaces would be a much larger feature slice and would risk mixing unproven model-backed learning with the storage/action foundation.
- Follow-up: Add bounded reflection and PR retrospective workflows using the configured self-improvement model, implement audited skill patch candidates, add dashboard/CLI learning review surfaces, and replace deterministic curation placeholders with model/user-authored rewrite proposals.

## 2026-06-30 - Kilo Reconciliation And Session Access

- Roadmap item: Phase 21 / KiloCode handoff reconciliation, session access, transcript controls, and dashboard/API basics
- Decision: Implemented restart reconciliation states for detached CLI tasks, dynamic managed-SDK session lookup when `@kilocode/sdk/v2` is locally installed, CLI session-list fallback, read-only SQLite discovery only for missing-session recovery, bounded transcript pages from persisted task events/raw logs, Kilo session read audit rows, child-session trees, diff-enriched Kilo task APIs, and Runtime Overview Kilo rows. Verification state and pending approvals are surfaced as explicit placeholders because the `review_kilo_result`, `verify_kilo_result`, and `promote_kilo_result` workflows are still deferred. No TUI was implemented.
- Reason: The installed project does not include a Kilo SDK/server dependency, so the managed adapter must remain optional and dependency-free. Persisted event/raw-log transcript pages provide useful bounded recovery without assuming unverified Kilo message/todo APIs, while direct disk reads must remain private recovery behavior. Keeping verification/promote as placeholders avoids inventing policy outside the dedicated roadmap workflows.
- Follow-up: Add first-class Kilo SDK/server lifecycle integration when the dependency and API are proven, implement true Kilo todo/diff/message adapters, add notification policy, and land review/verify/promote workflows with real verification and approval state.

## 2026-06-30 - Autopilot Triage And PR Worktree Preparation

- Roadmap item: Phase 19B / PR event autopilot triage and prepare worktree workflows
- Decision: Added `triage_pr_event` and `prepare_pr_worktree` workflow/action/API surfaces over a narrow structured PR event adapter, but did not add watcher event watermark persistence, queue admission, review comment lookup, fix, verify, push, or PR comment workflows. `prepare_pr_worktree` does not accept caller-supplied PR facts, check facts, or workflow run ids; it fetches GitHub facts server-side and reports that worktree run-id linkage is not attached yet.
- Reason: Phase 19A event/watermark ownership is not present in this worktree, and this slice was explicitly limited to classification plus isolated worktree preparation. Flue `ActionContext` intentionally excludes workflow identity, so accepting a caller-supplied run id would create a spoofable audit field.
- Follow-up: Phase 19A should feed durable watcher deltas into `triage_pr_event`; later Phase 19 slices should add unresolved review/check facts, reconciliation, fixer, verifier, push-back, comment, queue, dashboard surfaces, and a non-spoofable Flue run-id/worktree linkage if Flue exposes a supported run-context hook.

## 2026-06-30 - PR Event Model And Watermarks

- Roadmap item: Phase 19 / PR Event Autopilot
- Decision: Landed the read-only Phase 19A foundation: GitHub PR event-state collection, persistent per-watch event watermarks, focused lookup/actions, and local APIs. Deferred PR comment posting, triage workflow admission, worktree preparation, autonomous fixes, push-back, and dashboard queue panels.
- Reason: The delegated slice explicitly asked for the event model and watermarks only, and PR commenting/push/autofix behavior crosses into later mutating autopilot policy.
- Follow-up: Later Phase 19 work should add `triage_pr_event`, PR comment posting, worktree preparation, fix/verify/push workflows, concurrency controls, and dashboard/TUI queue surfaces on top of these watermarks.

## 2026-06-30 - Deterministic GitHub Review Facts And PR Comments

- Roadmap item: Phase 19 / deterministic GitHub review facts/actions
- Decision: Added focused Flue lookup tools for unresolved review comments/thread metadata, requested-changes state, and branch push permissions; added the `neondeck_pr_comment` action and local API route for server-side PR comment posting. Deferred a dedicated durable PR-comment audit table and did not implement the larger `comment_pr_autofix_result`, `fix_pr_review_feedback`, or push workflows.
- Reason: This slice was scoped to reusable GitHub facts/mutations. A first-class PR-comment audit table should be designed with the broader autopilot queue/push-back persistence contract instead of being bolted onto the review fact surface.
- Follow-up: Add durable PR comment/autofix event records when the Phase 19 comment/fix/push workflows and autopilot queue admission tables land.

## 2026-06-30 - Prepared-Diff Lifecycle And APIs

- Roadmap item: Phase 20 / prepared-diff records, approvals, and shared APIs/actions
- Decision: Added first-class `prepared_diffs` and `prepared_diff_approvals` app-state records, backend git-diff read APIs/actions, prepared-diff decision actions, app safety/runtime-skill guidance, and autopilot operator-state integration. `approve push` and `run verification` intentionally record state transitions and next workflow names only; they do not push to GitHub or execute checks.
- Reason: The delegated Phase 20 slice explicitly excluded actual push-back implementation, and this worktree still lacks the later `verify_pr_worktree` and `push_pr_autofix` execution workflows. Recording approval/request state now gives web and future TUI clients a stable shared surface without hiding GitHub or host mutations inside UI paths.
- Follow-up: Later Phase 19/20 work should implement `verify_pr_worktree`, `push_pr_autofix`, PR comment posting, permission checks, and human-readable workflow audit summaries using these prepared-diff records.

## 2026-06-30 - Autopilot Verification, Policy Limits, And Concurrency

- Roadmap item: Phase 19 / `verify_pr_worktree` and concurrency controls; Phase 20 / policy limits and high-risk approval classes
- Decision: Added config-backed autopilot policy limits, default high-risk diff classification, concurrency checks, a deterministic policy-check action, and a `verify_pr_worktree` action/workflow/API that runs configured checks through `neondeck_execution_run`. Deferred push-back, prepared-diff records, dedicated push/prepared-diff approval flows, human-readable timeline summaries, recovery actions, and broader fixture/smoke coverage.
- Reason: This slice was policy and verification infrastructure. Push-back and prepared-diff ownership require separate app-state records and approval UX so verification does not become an implicit push path.
- Follow-up: Later Phase 19/20 work should add push/readiness actions, prepared-diff records and APIs, explicit prepared-diff/push approval resolution, recovery controls, docs for autonomous modes, and smoke tests for push-blocking and same-PR queue admission.

## 2026-06-30 - PR CI Failure Fix Workflow

- Roadmap item: Phase 19 / `fix_pr_ci_failure`
- Decision: Added a bounded `fix_pr_ci_failure` action/workflow/API over managed PR worktrees. The workflow fetches failing check metadata, check output, annotations, and best-effort GitHub Actions job logs when a job id is available; otherwise it records explicit log-unavailable reasons. It runs inferred or supplied diagnostics through `neondeck_execution_run`, applies only supplied scoped V4A repo-edit patches through the repo-edit service, commits local changes by default with a generated PR/check-referencing message, and creates or updates prepared-diff records. It does not synthesize patches inside the deterministic action, push to GitHub, or post PR comments.
- Reason: This keeps host file mutations behind repo-edit actions and host execution behind the approval policy while leaving semantic patch generation to an audited caller or future model-planning workflow step. GitHub full logs are not uniformly exposed through check-run metadata, so the safe implementation records availability instead of pretending logs were fetched.
- Follow-up: Add model/planner orchestration for generating scoped patches from fetched facts, add provider-specific full-log adapters where available, and add a true Flue smoke test for the workflow admission path.

## 2026-06-30 - PR Review Feedback Fix Workflow

- Roadmap item: Phase 19 / `fix_pr_review_feedback`
- Decision: Implemented the workflow/action/API as a bounded deterministic fixer that fetches GitHub review/requested-change facts, groups unresolved comments by file/topic, reads target files through repo-edit, and applies only explicit caller-supplied repo-edit replacements or V4A patches before making a local worktree commit and prepared-diff record. It does not synthesize arbitrary edits inside the service, push to GitHub, or post PR comments.
- Reason: The roadmap requires file changes to route through repo-edit actions and the current verified Flue surface does not provide a safe, typed one-shot code-generation API for autonomous patch synthesis. Keeping edit intent explicit gives fixture-driven coverage now without adding an unbounded model-to-files path.
- Follow-up: Add a model-planning layer or delegated worker that produces bounded repo-edit replacements/patches from the grouped plan, then feed those edits into this workflow. Later Phase 19/20 slices still own CI-failure fixes, push-back, PR result comments, and full workflow smoke tests.

## 2026-06-30 - Kilo Review Verify Promote Foundation

- Roadmap item: Phase 21 / KiloCode review, verify, and promote workflows
- Decision: Added bounded `review_kilo_result` and `verify_kilo_result` workflows/actions, Kilo result state/event tables, Kilo result APIs, Runtime Overview state wiring, and a `promote_kilo_result` admission layer. Actual commit, push, and PR comment mutations are explicitly deferred.
- Reason: Safe promotion needs the broader push-back workflow, durable PR comment audit, and commit/push implementation. This slice establishes deterministic gates over autopilot policy, prepared-diff approval state, GitHub permission facts, and verification without silently adding unsafe GitHub mutations.
- Follow-up: Implement the real push/comment path in the Phase 19/20 push-back workflow, then let `promote_kilo_result` call or admit that workflow when all gates pass.

## 2026-06-30 - PR Autofix Result Comments And Audit Summaries

- Roadmap item: Phase 19 / `comment_pr_autofix_result`; Phase 20 / human-readable autonomous audit summaries
- Decision: Added a bounded `comment_pr_autofix_result` workflow/action/API that renders PR comments from prepared-diff/autopilot result facts and posts through the existing server-side PR comment action. Prepared-diff summaries now include a human-readable audit summary, and posted/failed result-comment attempts persist a `workflow_summaries` audit record. This slice did not add a dedicated PR-comment audit table or implement `push_pr_autofix`.
- Reason: `workflow_summaries` is the existing durable timeline surface and avoids duplicating the prepared-diff/autopilot business state. Push-back is still explicitly out of scope for this slice, so the result comment consumes prepared/pushed/blocked facts without performing GitHub branch mutations.
- Follow-up: Add the real `push_pr_autofix` workflow and a first-class PR-comment/autopilot event table when queue admission and push-back persistence land.

## 2026-06-30 - Kilo Notification Policy And Dashboard State

- Roadmap item: Phase 21 / Kilo notification policy and richer dashboard/API state
- Decision: Added deterministic Kilo notification states for started, progress, waiting-approval, completed, failed, timed-out, needs-review, verified, promote-blocked, and promoted; enriched Kilo task list/status API results with active notification facts and result placeholders; and surfaced those facts in Runtime Overview rows. Actual commit/push/comment promotion, future TUI controls, provider-specific deploy adapters, and managed `kilo serve`/SDK lifecycle work remain deferred.
- Reason: Existing Kilo task/session/result tables, app-state notifications, and review/verify/promote workflows already provide enough durable facts for notification-linked dashboard state. Reusing them avoids a second runtime and keeps Kilo delegation explicit.
- Follow-up: Add first-class Kilo SDK/server lifecycle integration, true todo/diff/message adapters, future TUI controls over the same APIs, and real promote mutation through the prepared-diff/autopilot push-back workflow.

## 2026-06-30 - Kilo Workflow Smoke Coverage

- Roadmap item: Phase 21 / KiloCode workflow smoke and integration coverage
- Decision: Added deterministic Kilo workflow smoke coverage for `handoff_to_kilo`, `reconcile_kilo_task`, `summarize_kilo_session`, `review_kilo_result`, `verify_kilo_result`, and `promote_kilo_result` using a fake JSONL Kilo CLI, temporary runtime homes, temporary repos, and managed worktrees. Added a `smoke:kilo` script that routes each named workflow through `flue run workflow:<name>` before the fixture-driven Vitest suite exercises the deeper managed-worktree success path.
- Reason: The smoke should validate Neondeck/Flue workflow wiring and app-state transitions without live Kilo, network, or provider dependencies. `promote_kilo_result` remains admission-only because actual commit/push/comment mutations are intentionally owned by the push-back workflows.
- Follow-up: Add SDK/server-backed session/todo/diff fixtures and actual promotion mutation coverage only after those provider/runtime contracts are implemented.

## 2026-07-02 - Phase 22 Reflection And Curation Orchestration

- Roadmap item: Phase 22 / model-backed conversation reflection and memory curation.
- Decision: Added bounded Flue workflows for conversation learning review and model-backed memory curation, backed by the configured self-improvement model and a `learning_reviewer` subagent role. Added app-owned turn counters that queue reflection after `learning.conversationReviewTurnInterval` and curation after `learning.memoryCurationTurnInterval`. Persisted learning review records, compact input summaries, model/thinking-level selections, result summaries, and failures. Model output can only create review candidates or call existing typed memory actions. Manual API triggers and review listing were added; no dedicated dashboard or CLI surface was added.
- Reason: The current app intentionally does not mirror raw Flue transcripts in Neondeck SQLite and has no stable transcript paging adapter beyond audited metadata reads. This slice therefore reflects over compact session metadata, stored summaries, stale-context markers, loaded memory ids, and current memory summaries rather than copying raw conversation history into app state. Dashboard/CLI learning UX and PR/autopilot retrospectives remain larger follow-on items.
- Follow-up: Add a stable Flue transcript summary adapter if the runtime exposes one, add dedicated dashboard/CLI review/candidate surfaces, implement PR/autopilot retrospective triggers, and add skill patch proposal/apply/reject/rollback actions.

## 2026-07-02 - Phase 22 PR Retrospectives And Skill Patch Candidates

- Roadmap item: Phase 22 / PR/autopilot retrospectives, handled-event accounting, and skill patch learning.
- Decision: Added idempotent `pr_handled` learning events, threshold-based admission from the existing Flue `run_end` observation path with a durable admission marker, manual `review_pr_batch_for_learning` workflow/API trigger, compact PR retrospective evidence gathering, and review result handling that can create/apply memory changes only through existing memory actions. Added audited skill patch propose/list/apply/reject actions and APIs for the built-in Neondeck skill and user skills under `NEONDECK_HOME/skills`. Skill patch candidates preserve frontmatter, store before/after content, hashes, and a generated diff, and applied patches mark sessions stale through `config_history`. Automatic workflow skill patch application is append-only; whole-file replacements require review.
- Reason: The existing app has a reliable workflow observation path and compact app-state summaries but does not yet have first-class autopilot queue admission rows or a dedicated learning dashboard/CLI. Restricting automatic accounting to durable workflow/prepared-diff/Kilo/recovery results avoids over-counting speculative API calls. Full rollback can be reconstructed from retained before/after audit data, but an explicit rollback action would be a separate mutation surface.
- Follow-up: Add first-class autopilot queue/outcome accounting when that table exists, broaden automatic handled-event admission for direct non-workflow APIs if needed, add relevance-based user skill snippets to PR retrospectives, add dedicated dashboard/CLI learning controls, add an explicit skill patch rollback action, and add `docs/README.md` coverage if that file is introduced later.

## 2026-07-10 - Scheduler, Admission, Approval, And Baseline Refactor

- Roadmap item: scheduler/autopilot cleanup following `.plans/archived/SCHEDULER_ROUTINES_AUTOPILOT_MECHANICS_REVIEW_20260709.md`.
- Decision: Replaced the duplicate schedule/routine models with SQLite scheduled
  tasks, made watcher triage and worktree preparation durable admission stages,
  bound prepared-diff push approvals to the exact SHA and effective policy hash,
  and reset the unshipped app-database migration chain to one baseline.
- Reason: The project has no production compatibility requirement. Retaining
  old scheduler formats, unjournaled database repair/stamping, or generic
  approvals would make autonomous state harder to inspect and unsafe to replay.
- Follow-up: Later autonomous mutation stages remain bounded explicit workflows;
  do not reintroduce legacy scheduler formats, database repair chains, or
  unbound approval writes.

## 2026-07-11 - Conversational Briefings

- Roadmap item: Morning Briefing; Phase 7 commands; Phase 8 dashboard; Phase 16 durable chat sessions.
- Decision: Added dedicated `briefing_profiles` and `briefing_runs` app-state tables instead of overloading `workflow_summaries`. Reused the current scheduled-task admission, linked-session, Flue dispatch, observation, and notification primitives because the Routines module named in the proposal no longer exists. On installed Flue `1.0.0-beta.9`, continuing-agent dispatches settle from correlated `agent_end` success or terminal prompt `operation` failure observations; `submission_settled` is retained as a compatible direct-prompt signal but is not emitted for `dispatch()`. Retained the Briefing dashboard slot as a compact profile/run launcher and editor.
- Reason: Briefings need exact bounded snapshot persistence, instruction versioning, stable profile/session linkage, dispatch correlation, and queryable terminal state without treating assistant prose as application data. Dedicated rows preserve that contract and keep panel polling from returning snapshot bodies. The version-matched Flue events are the only correct terminal signals for continuing-agent dispatch in the installed runtime.
- Follow-up: None.

## 2026-07-14 - Task Authority Refactor Verification Cleanup

- Roadmap item: Phases 14, 19, and 20 / task authority refactor.
- Decision: Included formatter-only normalization of pre-existing drift in the `tidy-briefings-glow.md` changeset, CLI onboarding/options, handoff/watch tests, runtime/config/watch/scheduled-task modules, and the baseline snapshot while implementing the single-PR authority refactor.
- Reason: These unrelated files failed the repository-wide `npm run format:check` acceptance gate before the authority implementation could pass full verification.
- Follow-up: None.

## 2026-07-14 - Task Authority Push Confirmation Binding

- Roadmap item: Phases 14, 19, and 20 / task authority refactor.
- Decision: Interactive push expansion acknowledgments carry a deterministic
  confirmation token bound to the reviewed commit SHA, guardrail policy hash, and
  human effect summary, in addition to the plan's `acknowledgeExpansion` boolean.
- Reason: Static correctness review found that a bare boolean could authorize a
  different commit or effect if the worktree changed between prompt and retry. The
  token keeps the plan's inline one-confirmation UX without creating an approval
  subsystem.
- Follow-up: None. The token is returned by the same typed push action and is
  documented in the agent/runtime skill guidance.

## 2026-07-14 - Task Authority Cooperative Preemption

- Roadmap item: Phases 14, 19, and 20 / task authority refactor.
- Decision: Interactive takeover requests explicitly mark the autonomous mutation
  lease revoked, wait within the original typed action until the autonomous owner
  reaches a lease check and releases normally, then acquire the lock and continue the
  requested commit or push. A revoked owner that does not yield becomes reclaimable
  after the same 30-second cooperative grace instead of retaining the PR lock for its
  original one-hour TTL, allowing the original interactive request to recover it. The
  interactive path does not forcibly release a lock during the grace while work may
  be in flight.
- Reason: Static correctness review identified a race where Git or diagnostic work
  already running after its last lease check could overlap the immediate interactive
  takeover. Cooperative handoff preserves interactive priority without concurrent
  mutation.
- Follow-up: None. Autonomous command loops, commit, push, and result-persistence
  boundaries recheck the explicit `revoked_at` lease state, and contention coverage
  proves that the first interactive call completes after cooperative handoff. Lock
  coverage proves fresh revocations remain exclusive during the grace and become
  recoverable afterward.

## 2026-07-19 - Autopilot Product-Closure Plan Consolidation

- Roadmap item: Phases 19–21 / watched-PR Autopilot product closure.
- Decision: Reopened the Phase 19 and 20 completion claims, added
  `.plans/AUTOPILOT_IMPLEMENTATION_PLAN.md` as the implementation source of truth,
  retained the HTML end-to-end review as evidence, and archived the superseded
  partial loop-wiring plan and July 9 scheduler/Autopilot mechanics review. The
  consolidated plan selects one continuing Neon PR-owner session and managed
  workspace per Autopilot watch, with bounded serialized event turns, as the
  default watched-PR fixer. It keeps Kilo explicit or policy-opted and routes both
  through one durable admission/owner coordinator.
- Reason: The end-to-end audit proved that production watcher progression stops
  after managed worktree preparation. Individually callable fix, verification,
  approval, push, comment, Kilo, and recovery primitives do not constitute a usable
  Autopilot without a continuing PR owner, coordinator, explicit setup, accurate
  operator state, and product-path verification. Reusing the same session preserves
  the diagnosis and implementation context across repeated review cycles, while
  fresh deterministic envelopes keep mutable authority and PR facts current.
- Follow-up: Implement Packages 1–8 in the consolidated plan and mark roadmap items
  complete only after their exit gates and the watcher-to-cleanup acceptance suite
  pass.

## 2026-07-19 - Autopilot Package 1 Active-Attempt Identity

- Roadmap item: Phase 19 / Autopilot Package 1 durable coordinator foundation.
- Decision: Add `owner_id` and `created_at` to stage attempts and a
  `current_stage_attempt_id` pointer to admissions in addition to the conceptual
  Package 1 field list. Enforce one reserved/running attempt per owner with a
  partial unique index and key every dispatch registration, terminal settlement,
  stop, and supersession CAS to that exact attempt.
- Reason: SQLite cannot enforce a partial uniqueness rule across an admission join,
  and stale reservations without a reservation timestamp cannot be reconciled
  safely. The denormalized owner identity and explicit pointer make the plan's
  one-active-turn invariant and late-observation rejection enforceable at the
  database boundary.
- Follow-up: Packages 4–5 should attach owner dispatch ids and workflow run ids to
  this same attempt record rather than introducing another active-run pointer.

## 2026-07-19 - Kilo Verification Fixture Spawn Synchronization

- Roadmap item: Phase 19 / Autopilot Package 1 verification gate.
- Decision: Add one test-only `await once(child, 'spawn')` synchronization to the
  existing Kilo persisted-process concurrency fixture before it records the child
  PID and asks production reconciliation to inspect it. No Kilo production code or
  behavior changes.
- Reason: The isolated integration test failed repeatedly before this Package 1
  change while `git diff -- src/modules/kilo src/kilo-actions.test.ts` was empty,
  proving the race was present in the `origin/main` implementation under test. The
  fixture could reconcile between `spawn()` returning and the child emitting its
  successful `spawn` event, incorrectly treating the simulated persisted process
  as absent. Waiting for that event reproducibly made the isolated baseline test
  pass and is required for the repository's mandatory full verification gate.
- Follow-up: Keep process-liveness behavior unchanged; this synchronization belongs
  only to fixtures that create a fresh child to simulate a pre-existing process.

## 2026-07-19 - Integration Fixture And Test Budget

- Roadmap item: Phase 19 / Autopilot Package 1 verification gate.
- Decision: Set the integration-only Vitest `testTimeout` and `hookTimeout` to 60
  seconds, matching the budget already selected locally by the slowest integration
  suites. Production code and unit/git suite budgets are unchanged.
- Reason: In the mandatory `npm run verify` sequence, the preceding 87-second git
  suite left three concurrent repository-seed `beforeAll` hooks over Vitest's
  default 10-second hook budget; all three timed out before their test bodies ran.
  After those hooks were allowed to complete, an unrelated repo-edit push test hit
  the shared 15-second body budget at 15.013 seconds under the same post-suite load.
  The integration suite cleared these fixtures when run cleanly, confirming harness
  resource latency rather than a Package 1 regression. The explicit integration
  budgets let the required combined verification exercise the actual tests.
- Follow-up: Keep slow fixture setup visible in CI timing; optimize or share the
  repository seed separately if it approaches the explicit 60-second budget.

## 2026-07-19 - Autopilot Package 2 Fingerprint-Bound Feedback And Initial Delivery

- Roadmap item: Phase 19 / Autopilot Package 2 event intake and process-existing behavior.
- Decision: Persist addressed review-thread/comment state as item fingerprints instead of permanent bare ids, snapshot every current comment when a whole thread is addressed, and couple notify-only synthetic delivery with `initial_event_processed_at` in one SQLite transaction. Admission-backed modes advance the same marker only after the Package 1 admission is durably claimed. For `processExisting: false`, fetch complete authoritative event facts before a watch becomes pollable, atomically persist their fingerprint watermarks with a processed marker, and use ordinary previous/current comparison from the first poll onward. Reconfiguration captures a fresh baseline, and the migration marks pre-existing watches processed while retaining their existing watermarks.
- Reason: A permanent id filter would hide edited feedback, while recording only a thread's latest comment would replay its older comments after restart. Advancing the initial-processing marker before either admission or notification durability could also lose the user's explicit process-existing request during a crash. Timestamp cutoffs cannot distinguish feedback created later in the same GitHub timestamp second and can replay older facts when a watch is reconfigured or upgraded. Fingerprint-bound baselines re-admit only edited or appended feedback, and the atomic baseline/marker and notification/marker writes give every mode restart-safe one-shot semantics.
- Follow-up: Package 5 should use this addressing ledger when it posts final pushed-SHA results and thread replies; it must continue to record the exact fingerprints represented by each delivery rather than reverting to permanent id suppression.

## 2026-07-19 - Autopilot Package 2 Verification Formatting Cleanup

- Roadmap item: Phase 19 / Autopilot Package 2 verification gate.
- Decision: Include Prettier-only normalization of the generated Package 2 migration snapshot and the pre-existing `src/kilo-actions.test.ts` formatting drift; do not change Kilo behavior.
- Reason: The mandatory repository-wide `npm run verify` gate passed tests, builds, package inspection, and packed-CLI smoke, then failed only its final `format:check` on those two files. `src/kilo-actions.test.ts` had no implementation diff before the formatter-only cleanup.
- Follow-up: None.

## 2026-07-19 - Autopilot Package 2 Durable Intake And Delivery Identity Hardening

- Roadmap item: Phase 19 / Autopilot Package 2 event intake, process-existing behavior, and exact-SHA checkout.
- Decision: Added a versioned, append-retained PR event intake ledger. A complete candidate snapshot is staged before any acknowledged watermark changes; durable admission, atomic notification delivery, no-op completion, or an operator baseline reset then advances the watermark in the same SQLite transaction as the intake outcome. Pending intake is replayed before GitHub access, incomplete or budget-exhausted facts never stage, legacy watches receive one complete v2 seed without replay, and false-mode terminal rearm atomically supersedes pending history with a fresh baseline. Opaque watch generations rotate on baseline reset/rearm and CAS slow post-fetch updates; each intake persists that generation, and admission transactionally requires the exact event fingerprint, pending intake lease, persisted intake generation, and live watch generation. Removal/reset therefore cannot leave an orphan intake, stale notification, admission, or dispatch when it wins the transaction race. Bot identity and unsigned comment markers are not trusted for suppression. Only exact persisted Neondeck comment ids plus stable comment-only delivery fingerprints suppress self-delivery; conversation comments remain explain-only candidate-reasoning inputs with deterministic mutation disabled. Exact-head fetch resolves the configured remote that matches the registered repository, validates full SHA/ref/remote inputs, and terminates Git option parsing.
- Reason: Advancing watermarks during fetch could lose feedback across a crash, while treating incomplete pagination as handled could permanently hide co-occurring feedback. A watch can be removed, recreated, reset, or rearmed while GitHub facts or policy are still in flight, so id-only checks would let an old generation overwrite a fresh baseline or admit superseded work. Generation CAS plus the exact pending-intake admission lease gives remove/reset and admission one serialized winner. Permanent bot/marker suppression could hide valid requests or be forged. Thread-state fields are unsuitable for self-delivery identity because resolution changes independently of comment delivery. Registered-remote matching and strict argument validation prevent ambient `origin` assumptions and option injection.
- Follow-up: Package 4 performs semantic interpretation of conversation-comment candidates. Package 5 must close the unavoidable external-effect window between a successful GitHub comment, submitted review, or thread-reply POST and the local delivery-ledger write by using its admission-scoped idempotent delivery coordinator; until then, a process crash in that window can leave an unrecorded self-delivery. Package 5 must also preserve exact review and comment-only delivery identity when posting final pushed-SHA results and replies. Package 7 owns stop/recovery semantics after an intake-backed admission transaction has already won its race and committed; Package 2 fences superseded or stale intakes before admission, but watch removal does not revoke a legitimately committed admission after that boundary.

## 2026-07-19 - Autopilot Package 3 Credential Proof And Actor Binding

- Roadmap item: Phases 19–20 / Autopilot Package 3 readiness and noninteractive credentials.
- Decision: Centralize local and target-specific readiness in one typed service while keeping GitHub API, exact fetch, Git credential/target, comment, author/committer identity, unattended check-command, and `gh` facts separate. The implementation lives in `src/modules/runtime/autopilot-readiness.ts`, with a compatibility re-export at the planned `src/modules/autopilot/readiness.ts` path through the runtime module's public index, because runtime status and doctor are lower-layer consumers and the repository import rules forbid them from depending on the Autopilot orchestration layer or bypassing another module's public index. Readiness never uses `push --dry-run` or a real push. HTTPS Git readiness obtains credentials through the configured helper or askpass without retaining them, validates the credential through bounded non-mutating GitHub repository/user lookups, and compares its actor with the separately evaluated API actor. SSH exact-target reachability remains a warning because the Git actor cannot be bound non-mutating to the API permission actor. The later push gate evaluates this same typed actor/target decision before executing `git push`. A shared process-group runner applies terminal-prompt, Git Credential Manager, SSH BatchMode, timeout, output-limit, redaction, and SIGTERM/SIGKILL behavior to all local production remote Git paths; exe.dev remote commands receive the equivalent explicit environment.
- Reason: A public `ls-remote` can succeed anonymously and cannot by itself predict an authenticated push. Likewise, GitHub API permissions obtained for one token cannot authorize a different helper or SSH identity. Separating the facts keeps operator output epistemically accurate, while binding HTTPS actors and refusing/warning on mismatched or unbound identities makes setup and the immediate pre-push gate agree without mutating a repository during readiness.
- Follow-up: Package 4 remains untouched and owns the continuing PR-owner instance/envelope. Packages 5–6 should present these canonical readiness blockers directly in admission setup and operator controls rather than duplicating credential logic.

## 2026-07-19 - Autopilot Package 4 Durable Grounding Audit And Verification Substitution

- Roadmap item: Phase 19 / Autopilot Package 4 continuing Neon PR-owner agent instance.
- Decision: Added normalized owner-generation, immutable grounding-snapshot, and one-time fix-submission tables beyond the Package 4 primary-file sketch. Grounding snapshots retain hashes/cursors/ids and accepted dispatch linkage but never retain the plaintext action token. Unknown config-history actions take the plan-permitted blocking path without advancing the owner baseline; model/provider/skill/SOUL changes rotate automatically at the next admitted owner turn and persist a compact audited handoff. Durable admission mutation epochs, synchronous terminal-fact persistence, explicit owner durability/stage limits, frozen generation capability snapshots, monotonic policy-transition authority, revision-bound reads, and bounded/hash-only submission persistence close the lifecycle audit. Successful prepared/no-op owner settlements emit one idempotent bounded `pr_handled` learning source. Flue `CompactionConfig` is documented as a bound on reconstructed model-visible context; it does not claim to compact the append-only canonical stream, persisted history, replay, or storage cost.
- Reason: Owner fields alone cannot prove which immutable prompt snapshot and one-time capability were accepted for a specific attempt/dispatch, cannot make action consumption restart-safe, and cannot preserve generation handoff history. The normalized rows make each side-effect boundary queryable and CAS-protected without copying transcripts or provider secrets into Neondeck app state.
- Verification deviation: Per explicit user instruction, Package 4 did not run `npm run verify` or any integration suite. The exit scenarios are deterministic fixture-backed unit/component tests. Their restart case reconstructs all dispatcher/service closures against the same file-backed app database; it does not kill/relaunch a real Flue server or invoke a live model/provider. Focused unit tests, `npm run check`, typecheck, format check, database migration check, and targeted server build are the permitted substitute evidence.
- Verification detail: The sequential closure fixture does run the production deterministic review fixer twice against a real temporary Git repository and managed worktree, including a local commit on the first turn, a persisted config-history plus repo-policy downgrade, and an uncommitted prepared-diff update on the second turn. Only the live Flue process/provider boundary remains simulated by accepted dispatch receipts and reconstructed dependency closures.
- Verification limitation: The compaction unit test verifies the configured `reserveTokens`/`keepRecentTokens` relationship and the version-matched Flue contract only. It does not run a live model/provider through enough canonical history to empirically observe reconstructed-input compaction; that remains part of Package 8's live Flue product-path smoke once the long-suite prohibition is lifted.
- Follow-up: Package 5 must consume `fix-prepared` owner settlements for verification/approval/push/comment/cleanup. Package 8 retains the real process-restart and live Flue product-path smoke obligations when the long-suite prohibition is lifted.
