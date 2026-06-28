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

const destructiveMutation = {
  class: 'destructive-mutation',
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
  action(
    'neondeck_execution_policy_check',
    'Check host execution policy',
    readOnly,
    'Classifies a proposed local or exe.dev command against execution approval policy without running it.',
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
    'Updates display-assistant or known subagent model strings using already registered providers.',
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
      auditTarget: 'neon_sessions',
    },
    'Starts a new active Flue agent session id and archives the previous active session.',
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
  route(
    '/api/runtime/status',
    'Runtime status API',
    readOnly,
    'Reads readiness facts for the dashboard and local API clients.',
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
    '/api/models',
    'Model config API',
    {
      ...safeMutation,
      auditTarget: 'config_history',
    },
    'Updates display-assistant and subagent model settings.',
  ),
  route(
    '/api/providers/kilocode',
    'Kilo provider config API',
    {
      ...safeMutation,
      auditTarget: 'config_history',
    },
    'Updates allowlisted Kilo provider environment variable references.',
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
  {
    id: 'future_host_shell_or_code_action',
    primitive: 'action',
    title: 'Run host shell or edit local code',
    class: 'host-execution',
    unattended: false,
    requiresConfirmation: true,
    audited: true,
    auditTarget: 'future approval log',
    notes:
      'Not implemented. The approval policy and preapproval checker are available now; actual local or exe.dev execution actions must call them and write approval/audit records first.',
  },
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
    hostExecutionPolicy: `Host execution is action-mediated. Backends enabled by config: ${execution.enabledBackends.join(', ')}. Preapproved single commands may run without an interactive approval in future executor actions; all other interactive commands require approval and unattended commands default to deny. Hardline commands cannot be preapproved.`,
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
