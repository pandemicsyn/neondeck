import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { type RuntimePaths, runtimePaths } from './runtime-home';
import { readExecutionPolicySync } from './execution-policy';

export type SafetyClass =
  'read-only' | 'safe-mutation' | 'destructive-mutation' | 'host-execution';

export type SafetyPrimitive = 'tool' | 'action' | 'workflow' | 'route';

export type SafetyPolicyEntry = {
  id: string;
  primitive: SafetyPrimitive;
  title: string;
  class: SafetyClass;
  unattended: boolean;
  requiresConfirmation: boolean;
  audited: boolean;
  auditTarget: string;
  notes: string;
};

export type SafetyPolicy = {
  ok: boolean;
  action: 'safety_policy_read';
  version: number;
  summary: {
    readOnly: number;
    safeMutation: number;
    destructiveMutation: number;
    hostExecution: number;
    requiresConfirmation: number;
    unattendedAllowed: number;
    audited: number;
  };
  confirmationPolicy: string;
  hostExecutionPolicy: string;
  executionPolicy: {
    defaultBackend: string;
    enabledBackends: string[];
    supportedBackends: string[];
    approvalMode: string;
    unattended: string;
    preapprovedCommandCount: number;
    defaultLocalAccess: boolean;
    exeDevPlanned: boolean;
  };
  entries: SafetyPolicyEntry[];
  fetchedAt: string;
};

const safetyPolicySchema = v.looseObject({
  ok: v.boolean(),
  action: v.literal('safety_policy_read'),
  version: v.number(),
  summary: v.looseObject({
    readOnly: v.number(),
    safeMutation: v.number(),
    destructiveMutation: v.number(),
    hostExecution: v.number(),
    requiresConfirmation: v.number(),
    unattendedAllowed: v.number(),
    audited: v.number(),
  }),
  entries: v.array(v.unknown()),
});

const readOnly = {
  class: 'read-only',
  unattended: true,
  requiresConfirmation: false,
  audited: false,
  auditTarget: 'none',
} satisfies Partial<SafetyPolicyEntry>;

const safeMutation = {
  class: 'safe-mutation',
  unattended: false,
  requiresConfirmation: false,
  audited: true,
} satisfies Partial<SafetyPolicyEntry>;

const unauditedSafeMutation = {
  class: 'safe-mutation',
  unattended: false,
  requiresConfirmation: false,
  audited: false,
  auditTarget: 'none',
} satisfies Partial<SafetyPolicyEntry>;

const destructiveMutation = {
  class: 'destructive-mutation',
  unattended: false,
  requiresConfirmation: true,
  audited: true,
} satisfies Partial<SafetyPolicyEntry>;

const hostExecution = {
  class: 'host-execution',
  unattended: false,
  requiresConfirmation: true,
  audited: true,
} satisfies Partial<SafetyPolicyEntry>;

const entries: SafetyPolicyEntry[] = [
  tool(
    'neondeck_safety_policy_lookup',
    'Read safety policy',
    readOnly,
    'Reads this approval and audit policy.',
  ),
  tool(
    'neondeck_commands_lookup',
    'List slash commands',
    readOnly,
    'Lists supported Neon slash commands.',
  ),
  tool(
    'neondeck_workflow_summaries_lookup',
    'Read workflow summaries',
    readOnly,
    'Reads persisted command and workflow summaries.',
  ),
  tool(
    'neondeck_runtime_status_lookup',
    'Read runtime readiness',
    readOnly,
    'Reads local runtime status, credentials presence, counts, and recent failure summaries.',
  ),
  tool(
    'neondeck_session_status_lookup',
    'Read active session state',
    readOnly,
    'Reads the active Neon session id and stale-context reasons.',
  ),
  tool(
    'neondeck_session_list_lookup',
    'List chat sessions',
    readOnly,
    'Reads indexed chat session metadata without reading Flue transcripts.',
  ),
  tool(
    'neondeck_session_search_lookup',
    'Search chat sessions',
    {
      ...readOnly,
      audited: true,
      auditTarget: 'chat_session_audit',
    },
    'Searches chat session metadata and summaries, recording an audit row.',
  ),
  tool(
    'neondeck_session_read_lookup',
    'Read chat session metadata',
    {
      ...readOnly,
      audited: true,
      auditTarget: 'chat_session_audit',
    },
    'Reads one indexed chat session metadata record and audits the read.',
  ),
  tool(
    'neondeck_session_messages_lookup',
    'Request session messages',
    {
      ...readOnly,
      audited: true,
      auditTarget: 'chat_session_audit',
    },
    'Audits a request for Flue-owned messages without duplicating transcripts into app state.',
  ),
  tool(
    'neondeck_repo_status_lookup',
    'Read local repo status',
    readOnly,
    'Reads deterministic git status for configured repositories.',
  ),
  tool(
    'neondeck_github_pr_queue_lookup',
    'Read GitHub PR queue',
    readOnly,
    'Fetches configured GitHub PR queue facts.',
  ),
  tool(
    'neondeck_github_check_summary_lookup',
    'Read GitHub check summary',
    readOnly,
    'Fetches GitHub check summary facts for a configured repository ref.',
  ),
  tool(
    'neondeck_pr_review_comments_lookup',
    'Read PR review comments',
    readOnly,
    'Fetches unresolved GitHub PR review comments and review thread metadata.',
  ),
  tool(
    'neondeck_pr_requested_changes_lookup',
    'Read requested changes',
    readOnly,
    'Fetches current requested-changes review state for a GitHub PR.',
  ),
  tool(
    'neondeck_pr_branch_permissions_lookup',
    'Read PR branch permissions',
    readOnly,
    'Fetches branch push permission facts for a GitHub PR without pushing.',
  ),
  tool(
    'neondeck_pr_watch_event_watermarks_lookup',
    'Read PR event watermarks',
    readOnly,
    'Reads persisted PR watch event watermarks without contacting GitHub.',
  ),
  tool(
    'neondeck_scheduler_jobs_lookup',
    'Read scheduler jobs',
    readOnly,
    'Reads durable scheduler jobs and last run state.',
  ),
  tool(
    'neondeck_pr_watches_lookup',
    'Read PR watches',
    readOnly,
    'Reads persistent PR watch state.',
  ),
  tool(
    'neondeck_ref_watches_lookup',
    'Read ref watches',
    readOnly,
    'Reads persistent branch and commit ref watch state.',
  ),
  tool(
    'neondeck_runtime_skills_lookup',
    'List runtime skills',
    readOnly,
    'Lists active, duplicate, and ignored runtime skill entries.',
  ),
  tool(
    'neondeck_runtime_skill_load',
    'Load runtime skill content',
    readOnly,
    'Reads trusted local skill instructions for a selected runtime skill.',
  ),
  tool(
    'neondeck_memory_lookup',
    'Read structured memory',
    readOnly,
    'Reads durable Neondeck memory scoped to user, project, session, or watch.',
  ),
  tool(
    'neondeck_worktrees_lookup',
    'Read worktree state',
    readOnly,
    'Reads Neondeck worktree records, active and stale locks, and cleanup failures.',
  ),
  tool(
    'neondeck_kilo_tasks_lookup',
    'Read Kilo handoff tasks',
    readOnly,
    'Reads persisted Kilo handoff task metadata without starting or cancelling work.',
  ),
  action(
    'neondeck_autopilot_triage_pr_event',
    'Triage PR event',
    readOnly,
    'Classifies structured PR watcher deltas without mutating GitHub, repos, or worktrees.',
  ),
  action(
    'neondeck_execution_policy_check',
    'Check host execution policy',
    readOnly,
    'Classifies a proposed local or exe.dev command against execution approval policy without running it.',
  ),
  action(
    'neondeck_execution_request_approval',
    'Request host execution approval',
    {
      ...safeMutation,
      auditTarget: 'execution_approvals',
    },
    'Creates a pending approval record for a non-preapproved local or exe.dev command without running it.',
  ),
  action(
    'neondeck_execution_run',
    'Run approved host command',
    {
      ...hostExecution,
      auditTarget: 'execution_approvals',
    },
    'Runs one approved local command or one approved exe.dev sandbox command, records bounded redacted output, and never bypasses hardline denies.',
  ),
  action(
    'neondeck_config_read',
    'Read runtime config',
    readOnly,
    'Reads validated runtime config files without exposing raw provider secrets.',
  ),
  action(
    'neondeck_config_validate',
    'Validate runtime config',
    readOnly,
    'Validates runtime config files and reports schema errors.',
  ),
  action(
    'neondeck_config_reload',
    'Reload runtime config snapshot',
    readOnly,
    'Validates and returns active disk-backed runtime config.',
  ),
  action(
    'neondeck_config_read_providers',
    'Read provider config',
    readOnly,
    'Reads allowlisted provider config without exposing secret values.',
  ),
  action(
    'neondeck_commands_list',
    'List slash commands',
    readOnly,
    'Lists supported Neon slash commands through an action surface.',
  ),
  action(
    'neondeck_workflow_summaries_list',
    'List workflow summaries',
    readOnly,
    'Lists persisted Neondeck workflow and command summaries.',
  ),
  action(
    'neondeck_watch_pr_list',
    'List PR watches',
    readOnly,
    'Lists persistent PR watches.',
  ),
  action(
    'neondeck_scheduler_list_jobs',
    'List scheduler jobs',
    readOnly,
    'Lists durable scheduler jobs and last run state.',
  ),
  action(
    'neondeck_skills_list',
    'List runtime skills',
    readOnly,
    'Lists discovered runtime skills.',
  ),
  action(
    'neondeck_skill_load',
    'Load runtime skill',
    readOnly,
    'Loads full content for a selected runtime skill.',
  ),
  action(
    'neondeck_session_status',
    'Read session status',
    readOnly,
    'Reads active Neon session state through an action surface.',
  ),
  action(
    'neondeck_session_list',
    'List chat sessions',
    readOnly,
    'Lists indexed chat session metadata.',
  ),
  action(
    'neondeck_session_search',
    'Search chat sessions',
    {
      ...readOnly,
      audited: true,
      auditTarget: 'chat_session_audit',
    },
    'Searches indexed chat session metadata and records an audit row.',
  ),
  action(
    'neondeck_session_read',
    'Read chat session metadata',
    {
      ...readOnly,
      audited: true,
      auditTarget: 'chat_session_audit',
    },
    'Reads one indexed chat session metadata record and records an audit row.',
  ),
  action(
    'neondeck_session_messages',
    'Request session messages',
    {
      ...readOnly,
      audited: true,
      auditTarget: 'chat_session_audit',
    },
    'Audits a request for Flue-owned messages. Neondeck app state does not store transcript copies.',
  ),
  action(
    'neondeck_memory_list',
    'List structured memory',
    readOnly,
    'Lists durable structured memory entries.',
  ),
  action(
    'neondeck_repo_status_list',
    'List repo status',
    readOnly,
    'Lists deterministic local git status facts.',
  ),
  action(
    'neondeck_worktree_status',
    'Read worktree status',
    readOnly,
    'Reads git status, head/base SHA, dirty state, and lock state for a managed worktree.',
  ),
  action(
    'neondeck_dev_doctor_run',
    'Run local dev diagnostics',
    readOnly,
    'Runs bounded read-only local diagnostics over repo status, package metadata, env presence, ports, API health, and database files.',
  ),
  action(
    'neondeck_command_run',
    'Run Neon command workflow action',
    {
      ...safeMutation,
      auditTarget: 'workflow_summaries/workflow_events',
    },
    'Runs supported slash commands and persists a workflow summary. Individual commands must stay within their own safety class.',
  ),
  action(
    'neondeck_config_add_repo',
    'Add repository config',
    {
      ...safeMutation,
      auditTarget: 'config_history',
    },
    'Adds a repo after local path, git, GitHub metadata, and schema validation.',
  ),
  action(
    'neondeck_config_update_repo',
    'Update repository config',
    {
      ...safeMutation,
      auditTarget: 'config_history',
    },
    'Updates an existing repo entry after schema and path validation.',
  ),
  action(
    'neondeck_config_update_agent_models',
    'Update agent model choices',
    {
      ...safeMutation,
      auditTarget: 'config_history',
    },
    'Updates display-assistant, utility, or known subagent model strings using already registered providers.',
  ),
  action(
    'neondeck_config_update_provider',
    'Update allowlisted provider config',
    {
      ...safeMutation,
      auditTarget: 'config_history',
    },
    'Updates allowlisted provider settings using environment variable references only; server restart is required.',
  ),
  action(
    'neondeck_config_update_execution_policy',
    'Update execution approval policy',
    {
      ...safeMutation,
      auditTarget: 'config_history',
    },
    'Updates allowed execution backends and preapproved single-command patterns. It does not execute commands.',
  ),
  action(
    'neondeck_config_update_worktree_policy',
    'Update worktree policy',
    {
      ...safeMutation,
      auditTarget: 'config_history',
    },
    'Updates default worktree storage and cleanup policy. Faster deletion policies should be confirmed with the user first.',
  ),
  action(
    'neondeck_config_update_dashboard_layout',
    'Update dashboard layout',
    {
      ...safeMutation,
      auditTarget: 'config_history',
    },
    'Replaces dashboard.json with a validated statusline plus tabbed-region layout.',
  ),
  action(
    'neondeck_config_apply_dashboard_preset',
    'Apply dashboard layout preset',
    {
      ...safeMutation,
      auditTarget: 'config_history',
    },
    'Applies a known dashboard layout preset such as classic or cockpit.',
  ),
  action(
    'neondeck_config_add_schedule',
    'Add schedule config',
    {
      ...safeMutation,
      auditTarget: 'config_history',
    },
    'Adds a validated schedule entry to schedules.json.',
  ),
  action(
    'neondeck_config_update_schedule',
    'Update schedule config',
    {
      ...safeMutation,
      auditTarget: 'config_history',
    },
    'Updates an existing schedule entry and can disable a schedule.',
  ),
  action(
    'neondeck_schedule_blueprint_create',
    'Create schedule blueprint',
    {
      ...safeMutation,
      auditTarget: 'config_history/jobs/pr_watches',
    },
    'Creates common schedules through typed blueprints and may create linked watch/job records.',
  ),
  action(
    'neondeck_scheduler_tick',
    'Run due scheduler jobs',
    {
      ...safeMutation,
      auditTarget: 'jobs/notifications/workflow_events',
    },
    'Runs due jobs and records job outcomes, notifications, and Flue workflow observations.',
  ),
  action(
    'neondeck_watch_pr_add',
    'Add PR watch',
    {
      ...safeMutation,
      auditTarget: 'pr_watches/jobs',
    },
    'Creates durable watch and job records after GitHub PR lookup.',
  ),
  action(
    'neondeck_watch_pr_refresh',
    'Refresh PR watch',
    {
      ...safeMutation,
      auditTarget: 'pr_watches/notifications',
    },
    'Refreshes a watch and records meaningful state changes; silent no-op refreshes should not notify.',
  ),
  action(
    'neondeck_github_pr_event_state_get',
    'Fetch PR event state',
    readOnly,
    'Fetches read-only GitHub PR event facts without persisting watermarks.',
  ),
  action(
    'neondeck_github_pr_review_threads_get',
    'Fetch PR review threads',
    readOnly,
    'Fetches read-only GitHub PR review thread and unresolved comment facts.',
  ),
  action(
    'neondeck_github_pr_requested_changes_get',
    'Fetch requested changes',
    readOnly,
    'Fetches read-only requested-changes review facts for a PR.',
  ),
  action(
    'neondeck_github_pr_branch_permissions_get',
    'Fetch PR branch permissions',
    readOnly,
    'Fetches read-only branch push permission facts without pushing.',
  ),
  action(
    'neondeck_pr_comment',
    'Post PR comment',
    unauditedSafeMutation,
    'Posts a GitHub PR comment through the server-side GitHub token and returns normalized comment metadata. Durable PR-comment audit records are deferred to the autopilot queue persistence slice.',
  ),
  action(
    'neondeck_pr_watch_event_state_refresh',
    'Refresh PR event watermarks',
    {
      ...safeMutation,
      auditTarget: 'pr_watch_event_watermarks',
    },
    'Fetches read-only GitHub PR event facts and updates per-watch app-state watermarks only.',
  ),
  action(
    'neondeck_pr_watch_event_watermarks_list',
    'List PR event watermarks',
    readOnly,
    'Lists persisted PR watch event watermarks.',
  ),
  route(
    '/api/github/prs/comment',
    'Post PR comment API',
    unauditedSafeMutation,
    'Local API route for posting a bounded PR comment with the server-side GitHub token. Durable PR-comment audit records are deferred to the autopilot queue persistence slice.',
  ),
  action(
    'neondeck_watch_ref_add',
    'Add ref watch',
    {
      ...safeMutation,
      auditTarget: 'ref_watches/jobs',
    },
    'Creates durable branch or commit ref watch and job records after GitHub check lookup.',
  ),
  action(
    'neondeck_watch_ref_refresh',
    'Refresh ref watch',
    {
      ...safeMutation,
      auditTarget: 'ref_watches/notifications',
    },
    'Refreshes a branch or commit ref watch and records meaningful state changes; silent no-op refreshes should not notify.',
  ),
  action(
    'neondeck_worktree_create',
    'Create or adopt worktree',
    {
      ...safeMutation,
      auditTarget: 'worktrees/worktree_events',
    },
    'Creates or adopts a git worktree only inside declared Neondeck worktree roots.',
  ),
  action(
    'neondeck_autopilot_prepare_pr_worktree',
    'Prepare PR worktree',
    {
      ...safeMutation,
      auditTarget: 'worktrees/worktree_locks',
    },
    'Creates, syncs, locks, and inspects a Neondeck-managed PR worktree, but does not edit, commit, push, or comment.',
  ),
  action(
    'neondeck_worktree_sync',
    'Sync worktree',
    {
      ...safeMutation,
      auditTarget: 'worktrees/worktree_events',
    },
    'Moves a clean managed worktree to a requested head ref or SHA and records lifecycle events.',
  ),
  action(
    'neondeck_worktree_lock',
    'Lock worktree or PR',
    {
      ...safeMutation,
      auditTarget: 'worktree_locks/worktree_events',
    },
    'Acquires expiring per-worktree or per-PR locks and recovers stale locks.',
  ),
  action(
    'neondeck_worktree_release',
    'Release worktree lock',
    {
      ...safeMutation,
      auditTarget: 'worktree_locks/worktree_events',
    },
    'Releases a lock and records the final bounded-work status.',
  ),
  action(
    'neondeck_kilo_task_start',
    'Start Kilo handoff',
    {
      ...hostExecution,
      auditTarget: 'kilo_tasks/kilo_task_events',
    },
    'Starts Kilo only after an explicit user handoff request and only inside a declared repo or Neondeck-managed worktree.',
  ),
  action(
    'neondeck_kilo_task_status',
    'Read Kilo task status',
    readOnly,
    'Reads one persisted Kilo task status record.',
  ),
  action(
    'neondeck_kilo_task_events',
    'Read Kilo task events',
    readOnly,
    'Reads captured Kilo stdout/stderr and JSON event summaries.',
  ),
  action(
    'neondeck_kilo_task_abort',
    'Abort Kilo handoff',
    {
      ...destructiveMutation,
      auditTarget: 'kilo_tasks/kilo_task_events',
    },
    'Terminates a running delegated Kilo process and marks the task cancelled.',
  ),
  action(
    'neondeck_kilo_task_sessions',
    'Read Kilo task sessions',
    readOnly,
    'Reads root and child Kilo session ids linked to one task.',
  ),
  action(
    'neondeck_kilo_task_diff',
    'Read Kilo task diff',
    readOnly,
    'Reads a git diff summary for the workspace used by a Kilo task.',
  ),
  action(
    'neondeck_kilo_sessions_search',
    'Search Kilo sessions',
    readOnly,
    'Searches linked task metadata and Kilo CLI session metadata.',
  ),
  action(
    'neondeck_kilo_session_read',
    'Read Kilo session',
    readOnly,
    'Reads normalized Kilo session metadata without reading storage directly.',
  ),
  action(
    'neondeck_kilo_session_messages',
    'Read Kilo session messages',
    readOnly,
    'Audits transcript-read intent; the CLI MVP reports transcript adapter availability.',
  ),
  action(
    'neondeck_kilo_session_children',
    'Read Kilo child sessions',
    readOnly,
    'Reads child session ids captured from Kilo task events.',
  ),
  action(
    'neondeck_kilo_session_todos',
    'Read Kilo todos',
    readOnly,
    'Reports Kilo todo adapter availability through the typed Kilo surface.',
  ),
  action(
    'neondeck_kilo_session_diff',
    'Read Kilo session diff',
    readOnly,
    'Reads the linked task workspace diff summary for a Kilo session.',
  ),
  action(
    'neondeck_skills_reload',
    'Reload runtime skills',
    {
      ...safeMutation,
      auditTarget: 'runtime skill cache',
    },
    'Rescans trusted local runtime skill folders. A new session is required before changed skills affect prompt context.',
  ),
  action(
    'neondeck_memory_upsert',
    'Write structured memory',
    {
      ...safeMutation,
      auditTarget: 'memories/memory_events',
    },
    'Writes scoped durable memory. Active prompt context changes only on a new session.',
  ),
  action(
    'neondeck_session_start',
    'Start new Neon session',
    {
      ...safeMutation,
      auditTarget: 'chat_sessions/chat_session_surfaces/chat_session_audit',
    },
    'Creates and activates a new Flue agent session id without deleting or copying previous history.',
  ),
  action(
    'neondeck_session_create',
    'Create chat session',
    {
      ...safeMutation,
      auditTarget: 'chat_sessions/chat_session_surfaces/chat_session_audit',
    },
    'Creates indexed chat session metadata and optionally activates it for a surface.',
  ),
  action(
    'neondeck_session_switch',
    'Switch active chat session',
    {
      ...safeMutation,
      auditTarget: 'chat_session_surfaces/chat_session_audit',
    },
    'Switches a dashboard or future TUI surface to an existing non-archived session.',
  ),
  action(
    'neondeck_session_rename',
    'Rename chat session',
    {
      ...safeMutation,
      auditTarget: 'chat_sessions/chat_session_audit',
    },
    'Renames indexed chat session metadata.',
  ),
  action(
    'neondeck_session_pin',
    'Pin chat session',
    {
      ...safeMutation,
      auditTarget: 'chat_sessions/chat_session_audit',
    },
    'Pins or unpins indexed chat session metadata.',
  ),
  action(
    'neondeck_session_archive',
    'Archive chat session',
    {
      ...safeMutation,
      auditTarget: 'chat_sessions/chat_session_audit',
    },
    'Archives session metadata without deleting Flue transcript history.',
  ),
  action(
    'neondeck_session_restore',
    'Restore chat session',
    {
      ...safeMutation,
      auditTarget: 'chat_sessions/chat_session_audit',
    },
    'Restores archived session metadata.',
  ),
  action(
    'neondeck_session_link_context',
    'Link chat session context',
    {
      ...safeMutation,
      auditTarget: 'chat_sessions/chat_session_audit',
    },
    'Links repo, watch, task, UI metadata, or summary data to indexed session metadata.',
  ),
  action(
    'neondeck_config_remove_repo',
    'Remove repository config',
    {
      ...destructiveMutation,
      auditTarget: 'config_history',
    },
    'Requires confirm=true before removing a configured repository.',
  ),
  action(
    'neondeck_config_remove_schedule',
    'Remove schedule config',
    {
      ...destructiveMutation,
      auditTarget: 'config_history',
    },
    'Requires confirm=true before removing a schedule from schedules.json.',
  ),
  action(
    'neondeck_watch_pr_remove',
    'Remove PR watch',
    {
      ...destructiveMutation,
      auditTarget: 'pr_watches/jobs',
    },
    'Requires confirm=true before removing the watch and related jobs.',
  ),
  action(
    'neondeck_memory_delete',
    'Delete structured memory',
    {
      ...destructiveMutation,
      auditTarget: 'memories/memory_events',
    },
    'Requires confirm=true before deleting durable memory and recording a memory event.',
  ),
  action(
    'neondeck_worktree_cleanup',
    'Clean up worktrees',
    {
      ...destructiveMutation,
      auditTarget: 'worktrees/worktree_cleanup_attempts',
    },
    'Deletes eligible Neondeck-owned worktrees according to cleanup policy and never deletes adopted worktrees without explicit confirmation.',
  ),
  workflow(
    'command-run',
    'Run command workflow',
    {
      ...safeMutation,
      auditTarget: 'workflow_summaries/workflow_events',
    },
    'Runs a bounded command through Flue with durable run identity and summaries.',
  ),
  workflow(
    'briefing',
    'Run briefing workflow',
    {
      ...safeMutation,
      auditTarget: 'workflow_summaries/workflow_events',
    },
    'Runs the bounded briefing workflow and records Flue observations.',
  ),
  workflow(
    'watch-pr',
    'Run watch-pr workflow',
    {
      ...safeMutation,
      auditTarget: 'pr_watches/jobs/workflow_events',
    },
    'Creates a PR watch through the Flue workflow surface.',
  ),
  workflow(
    'watch-release',
    'Run watch-release workflow',
    {
      ...safeMutation,
      auditTarget: 'config_history/jobs/workflow_events',
    },
    'Creates a release-watch schedule through the Flue workflow surface.',
  ),
  workflow(
    'triage-pr-event',
    'Run PR event triage workflow',
    readOnly,
    'Classifies a structured PR watcher delta through the Flue workflow surface without mutating GitHub, repos, or worktrees.',
  ),
  workflow(
    'prepare-pr-worktree',
    'Run PR worktree preparation workflow',
    {
      ...safeMutation,
      auditTarget: 'worktrees/worktree_locks/workflow_events',
    },
    'Creates, syncs, locks, and inspects an isolated PR worktree through the Flue workflow surface without fixing, committing, pushing, or commenting.',
  ),
  workflow(
    'dev-doctor',
    'Run dev-doctor workflow',
    readOnly,
    'Runs read-only local diagnostics through the Flue workflow surface.',
  ),
  workflow(
    'scheduler-tick',
    'Run scheduler-tick workflow',
    {
      ...safeMutation,
      auditTarget: 'jobs/notifications/workflow_events',
    },
    'Runs due scheduled work through the Flue workflow surface.',
  ),
  workflow(
    'handoff_to_kilo',
    'Run Kilo handoff workflow',
    {
      ...hostExecution,
      auditTarget: 'kilo_tasks/kilo_task_events/workflow_events',
    },
    'Admits an explicit Kilo handoff as a bounded Flue run, then lets the app supervisor own the background process.',
  ),
  workflow(
    'summarize_kilo_session',
    'Summarize Kilo session workflow',
    {
      ...safeMutation,
      auditTarget: 'kilo_tasks/workflow_events',
    },
    'Summarizes linked Kilo task/session metadata and persists the bounded summary on the task record.',
  ),
  route(
    '/api/runtime/status',
    'Runtime status API',
    readOnly,
    'Reads readiness facts for the dashboard and local API clients.',
  ),
  route(
    '/api/events/config',
    'Config event stream API',
    readOnly,
    'Streams local config change and reload notifications to dashboard surfaces.',
  ),
  route(
    '/api/events/notifications',
    'Notification event stream API',
    readOnly,
    'Streams notification inbox changes to dashboard surfaces without browser notification APIs.',
  ),
  route(
    '/api/events/sessions',
    'Session event stream API',
    readOnly,
    'Streams chat session metadata and active-surface changes to dashboard and future TUI clients.',
  ),
  route(
    '/api/config/reload',
    'Config reload API',
    {
      ...safeMutation,
      auditTarget: 'config_events',
    },
    'Validates runtime config files and emits a local config reload event without writing config.',
  ),
  route(
    '/api/dashboard/config',
    'Dashboard config API',
    {
      ...safeMutation,
      auditTarget: 'config_history',
    },
    'GET reads dashboard layout; POST replaces it with a validated statusline plus tabbed-region layout.',
  ),
  route(
    '/api/dashboard/preset',
    'Dashboard preset API',
    {
      ...safeMutation,
      auditTarget: 'config_history',
    },
    'Applies a known dashboard layout preset and emits config-change events.',
  ),
  route(
    '/api/safety/policy',
    'Safety policy API',
    readOnly,
    'Reads this safety policy for the dashboard and local API clients.',
  ),
  route(
    '/api/execution/policy',
    'Execution policy API',
    {
      ...safeMutation,
      auditTarget: 'config_history',
    },
    'GET reads host execution approval policy; POST updates policy and preapproved commands through audited config history.',
  ),
  route(
    '/api/execution/check',
    'Execution policy check API',
    readOnly,
    'Classifies a proposed host command without running it.',
  ),
  route(
    '/api/execution/approvals',
    'Execution approvals API',
    {
      ...safeMutation,
      auditTarget: 'execution_approvals',
    },
    'GET lists execution approval records; POST creates a pending approval request without running a command.',
  ),
  route(
    '/api/execution/approvals/:id/resolve',
    'Execution approval resolution API',
    {
      ...safeMutation,
      auditTarget: 'execution_approvals/config_history',
    },
    'Approves or denies a pending execution request. allow-always also updates preapproved command config.',
  ),
  route(
    '/api/execution/run',
    'Approved execution API',
    {
      ...hostExecution,
      auditTarget: 'execution_approvals',
    },
    'Runs one approved local or exe.dev command and records bounded redacted output.',
  ),
  route(
    '/api/autopilot/triage-pr-event',
    'PR event triage API',
    readOnly,
    'Classifies a structured PR watcher delta for dashboard, smoke-test, and future TUI clients.',
  ),
  route(
    '/api/autopilot/prepare-pr-worktree',
    'PR worktree preparation API',
    {
      ...safeMutation,
      auditTarget: 'worktrees/worktree_locks',
    },
    'Fetches deterministic GitHub PR/check facts and prepares a managed PR worktree without fixing, committing, pushing, or commenting.',
  ),
  route(
    '/api/session',
    'Active session API',
    readOnly,
    'Reads the active chat session for a dashboard or future TUI surface.',
  ),
  route(
    '/api/sessions',
    'Chat sessions API',
    {
      ...safeMutation,
      auditTarget: 'chat_sessions/chat_session_surfaces/chat_session_audit',
    },
    'GET lists indexed session metadata; POST creates and optionally activates a new session.',
  ),
  route(
    '/api/sessions/:id',
    'Chat session read API',
    {
      ...readOnly,
      audited: true,
      auditTarget: 'chat_session_audit',
    },
    'Reads one indexed session metadata record and audits the read.',
  ),
  route(
    '/api/sessions/:id/messages',
    'Chat session messages API',
    {
      ...readOnly,
      audited: true,
      auditTarget: 'chat_session_audit',
    },
    'Audits a request for Flue-owned messages without copying transcripts into app state.',
  ),
  route(
    '/api/sessions/:id/switch',
    'Chat session switch API',
    {
      ...safeMutation,
      auditTarget: 'chat_session_surfaces/chat_session_audit',
    },
    'Switches a local surface to an existing non-archived session id.',
  ),
  route(
    '/api/sessions/:id/*',
    'Chat session metadata mutation API',
    {
      ...safeMutation,
      auditTarget: 'chat_sessions/chat_session_audit',
    },
    'Renames, pins, archives, restores, or links context metadata without mutating Flue transcripts.',
  ),
  route(
    '/api/models',
    'Model config API',
    {
      ...safeMutation,
      auditTarget: 'config_history',
    },
    'Updates display-assistant, utility, and subagent model settings.',
  ),
  route(
    '/api/providers/:provider',
    'Provider config API',
    {
      ...safeMutation,
      auditTarget: 'config_history',
    },
    'Updates allowlisted provider environment variable references.',
  ),
  route(
    '/api/kilo/*',
    'Kilo handoff API',
    {
      ...hostExecution,
      auditTarget: 'kilo_tasks/kilo_task_events',
    },
    'Starts, reads, searches, and cancels explicit Kilo handoff tasks through app-owned SQLite state.',
  ),
  route(
    '/api/memories',
    'Memory API',
    {
      ...destructiveMutation,
      auditTarget: 'memories/memory_events',
    },
    'POST writes structured memory; DELETE requires confirm=true before deleting memory.',
  ),
];

export const safetyPolicyLookupTool = defineTool({
  name: 'neondeck_safety_policy_lookup',
  description:
    'Read Neondeck safety and approval policy for read-only, mutation, destructive, and future host-execution actions.',
  input: v.object({}),
  output: safetyPolicySchema,
  run() {
    return readSafetyPolicy();
  },
});

export function readSafetyPolicy(
  paths: RuntimePaths = runtimePaths(),
): SafetyPolicy {
  const execution = readExecutionPolicySync(paths);
  return {
    ok: true,
    action: 'safety_policy_read',
    version: 3,
    summary: summarizeEntries(entries),
    confirmationPolicy:
      'Destructive mutations require explicit user confirmation and action input confirm=true. Safe mutations should be user-directed and audited when they change durable state.',
    hostExecutionPolicy: `Host execution is action-mediated. Backends enabled by config: ${execution.enabledBackends.join(', ')}. Preapproved single commands may run without an interactive approval through neondeck_execution_run; all other interactive commands require approval and unattended commands default to deny. Hardline commands cannot be preapproved.`,
    executionPolicy: {
      defaultBackend: execution.defaultBackend,
      enabledBackends: execution.enabledBackends,
      supportedBackends: execution.supportedBackends,
      approvalMode: execution.approvalMode,
      unattended: execution.unattended,
      preapprovedCommandCount: execution.preapprovedCommands.length,
      defaultLocalAccess: execution.defaults.localAccess,
      exeDevPlanned: execution.defaults.exeDevPlanned,
    },
    entries,
    fetchedAt: new Date().toISOString(),
  };
}

function tool(
  id: string,
  title: string,
  policy: Partial<SafetyPolicyEntry>,
  notes: string,
) {
  return entry('tool', id, title, policy, notes);
}

function action(
  id: string,
  title: string,
  policy: Partial<SafetyPolicyEntry>,
  notes: string,
) {
  return entry('action', id, title, policy, notes);
}

function workflow(
  id: string,
  title: string,
  policy: Partial<SafetyPolicyEntry>,
  notes: string,
) {
  return entry('workflow', id, title, policy, notes);
}

function route(
  id: string,
  title: string,
  policy: Partial<SafetyPolicyEntry>,
  notes: string,
) {
  return entry('route', id, title, policy, notes);
}

function entry(
  primitive: SafetyPrimitive,
  id: string,
  title: string,
  policy: Partial<SafetyPolicyEntry>,
  notes: string,
): SafetyPolicyEntry {
  return {
    id,
    primitive,
    title,
    class: policy.class ?? 'read-only',
    unattended: policy.unattended ?? false,
    requiresConfirmation: policy.requiresConfirmation ?? false,
    audited: policy.audited ?? false,
    auditTarget: policy.auditTarget ?? 'none',
    notes,
  };
}

function summarizeEntries(items: SafetyPolicyEntry[]): SafetyPolicy['summary'] {
  return {
    readOnly: items.filter((item) => item.class === 'read-only').length,
    safeMutation: items.filter((item) => item.class === 'safe-mutation').length,
    destructiveMutation: items.filter(
      (item) => item.class === 'destructive-mutation',
    ).length,
    hostExecution: items.filter((item) => item.class === 'host-execution')
      .length,
    requiresConfirmation: items.filter((item) => item.requiresConfirmation)
      .length,
    unattendedAllowed: items.filter((item) => item.unattended).length,
    audited: items.filter((item) => item.audited).length,
  };
}
