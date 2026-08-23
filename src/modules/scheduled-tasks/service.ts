import { randomUUID } from 'node:crypto';
import { asJsonValue } from '../../lib/action-result';
import {
  ensureRuntimeHome,
  parseRepoRegistry,
  readRuntimeJson,
  runtimePaths,
} from '../../runtime-home';
import { captureWorkspaceProviderSnapshot } from '../workspace-providers';
import { readChatSessionInternal } from '../sessions/store';
import {
  automationTriggerSchema,
  nonEmptyStringSchema,
  scheduledTaskSpecSchema,
  scheduledWorkspacePolicySchema,
} from './schemas';
import {
  deleteScheduledTask,
  listScheduledTasks,
  readLatestScheduledTaskRun,
  readActiveScheduledTaskRun,
  listScheduledTaskRuns,
  makeScheduledTaskDue,
  readScheduledTaskRun,
  readScheduledTask,
  setScheduledTaskEnabled,
  upsertScheduledTask,
} from './store';
import {
  cleanupScheduledWorkspace,
  scheduledRunWorkspaceDetail,
} from './workspace-service';
import {
  clearPhysicalWorkspaceQuarantine,
  acquireWorkspaceProviderCoordinator,
  listPhysicalWorkspaceQuarantines,
  releaseWorkspaceProviderCoordinator,
  superviseWorkspaceProviderCoordinator,
  retainTaskWorkspace,
} from './workspace-store';
import { sanitizedBoundedContent } from './content';
import * as v from 'valibot';

const agentTargetSchema = v.variant('kind', [
  v.object({ kind: v.literal('agent') }),
  v.object({
    kind: v.literal('agent-session'),
    sessionId: nonEmptyStringSchema,
  }),
]);

export const briefingTaskInputSchema = v.object({
  id: nonEmptyStringSchema,
  trigger: automationTriggerSchema,
  enabled: v.optional(v.boolean()),
});

export const agentInstructionTaskInputSchema = v.object({
  prompt: v.pipe(v.string(), v.minLength(1), v.maxLength(8_000)),
  trigger: automationTriggerSchema,
  target: v.optional(agentTargetSchema),
  repoId: v.optional(nonEmptyStringSchema),
  cwd: v.optional(nonEmptyStringSchema),
  skills: v.optional(
    v.pipe(
      v.array(nonEmptyStringSchema),
      v.check(
        (skills) => new Set(skills).size === skills.length,
        'Scheduled task skill ids must be unique.',
      ),
    ),
  ),
  workspace: v.optional(scheduledWorkspacePolicySchema),
  enabled: v.optional(v.boolean()),
  confirm: v.optional(v.boolean()),
});

export const scheduledTaskIdInputSchema = v.object({
  id: nonEmptyStringSchema,
});

export const scheduledWorkspaceCleanupInputSchema = v.object({
  runId: nonEmptyStringSchema,
  confirm: v.optional(v.boolean()),
});

export const scheduledWorkspaceQuarantineClearInputSchema = v.object({
  physicalResourceKey: nonEmptyStringSchema,
  confirm: v.optional(v.boolean()),
});

export type ScheduledTaskActionResult = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  task?: ReturnType<typeof asJsonValue>;
  tasks?: ReturnType<typeof asJsonValue>[];
  run?: ReturnType<typeof asJsonValue>;
  errors?: string[];
  requires?: string[];
};

export async function createBriefingTask(
  rawInput: unknown,
  paths = runtimePaths(),
): Promise<ScheduledTaskActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(briefingTaskInputSchema, rawInput);
  if (!parsed.success)
    return invalidResult('scheduled_task_briefing_create', parsed);
  const triggerError = pastOneShotTriggerMessage(parsed.output.trigger);
  if (triggerError)
    return failure('scheduled_task_briefing_create', triggerError);
  try {
    const task = await upsertScheduledTask(
      {
        id: `briefing:${parsed.output.id}`,
        spec: { kind: 'run-briefing', briefingId: parsed.output.id },
        trigger: parsed.output.trigger,
        enabled: parsed.output.enabled,
      },
      paths,
    );
    return success(
      'scheduled_task_briefing_create',
      task,
      'Created briefing task.',
    );
  } catch (error) {
    return failure('scheduled_task_briefing_create', error);
  }
}

export async function createAgentInstructionTask(
  rawInput: unknown,
  paths = runtimePaths(),
): Promise<ScheduledTaskActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(agentInstructionTaskInputSchema, rawInput);
  if (!parsed.success) {
    return invalidResult('scheduled_task_instruction_create', parsed);
  }
  const input = parsed.output;
  const triggerError = pastOneShotTriggerMessage(input.trigger);
  if (triggerError)
    return failure('scheduled_task_instruction_create', triggerError);
  if (
    input.trigger.kind !== 'once' &&
    input.workspace?.kind === 'repository' &&
    input.workspace.authority !== 'read-only' &&
    input.confirm !== true
  ) {
    return {
      ok: false,
      action: 'scheduled_task_instruction_create',
      changed: false,
      message:
        'Recurring scheduled shell tasks have credential-stripped arbitrary shell and network authority. Explicit confirmation is required.',
      requires: ['confirm'],
    };
  }
  try {
    if (
      input.workspace?.kind === 'repository' &&
      (input.repoId !== undefined || input.cwd !== undefined)
    ) {
      return failure(
        'scheduled_task_instruction_create',
        'Repository workspace tasks must use workspace.repoId and workspace.subdirectory; legacy repoId/cwd fields are not accepted.',
      );
    }
    if (input.target?.kind === 'agent-session') {
      const session = await readChatSessionInternal(
        input.target.sessionId,
        paths,
      );
      if (
        !session ||
        session.archivedAt ||
        session.agentName !== 'display-assistant'
      ) {
        return {
          ok: false,
          action: 'scheduled_task_instruction_create',
          changed: false,
          message:
            'Agent-session targets must reference an active display-assistant chat session.',
          requires: ['activeChatSession'],
        };
      }
      if (
        input.workspace?.kind === 'repository' &&
        input.workspace.overlap === 'allow-parallel'
      ) {
        return failure(
          'scheduled_task_instruction_create',
          'Repository agent-session targets require serialized overlap. The session id names continuing scheduled-worker context, not the display-assistant conversation.',
        );
      }
    }
    const coordinatorOwner = `scheduled-task-config:${randomUUID()}`;
    if (!(await acquireWorkspaceProviderCoordinator(coordinatorOwner, paths))) {
      return failure(
        'scheduled_task_instruction_create',
        'Repository or workspace provider configuration is being updated. Retry shortly.',
      );
    }
    const coordinatorLease = superviseWorkspaceProviderCoordinator(
      coordinatorOwner,
      paths,
    );
    try {
      coordinatorLease.assertLease();
      const referencedRepoId =
        input.workspace?.kind === 'repository'
          ? input.workspace.repoId
          : input.repoId;
      if (referencedRepoId) {
        const repos = await readRuntimeJson(paths.repos, parseRepoRegistry);
        if (!repos.repos.some((repo) => repo.id === referencedRepoId)) {
          return failure(
            'scheduled_task_instruction_create',
            `Repository "${referencedRepoId}" is not configured.`,
          );
        }
      }
      if (input.workspace?.kind === 'repository') {
        captureWorkspaceProviderSnapshot(input.workspace.providerId, paths);
      }
      const task = await upsertScheduledTask(
        {
          id: `instruction:${randomUUID()}`,
          spec: v.parse(scheduledTaskSpecSchema, {
            kind: 'run-agent-instruction',
            prompt: input.prompt,
            target: input.target ?? { kind: 'agent' },
            ...(input.repoId ? { repoId: input.repoId } : {}),
            ...(input.cwd ? { cwd: input.cwd } : {}),
            skills: input.skills ?? [],
            ...(input.workspace ? { workspace: input.workspace } : {}),
          }),
          trigger: input.trigger,
          enabled: input.enabled,
        },
        paths,
      );
      coordinatorLease.assertLease();
      return success(
        'scheduled_task_instruction_create',
        task,
        'Created agent-instruction task.',
      );
    } finally {
      coordinatorLease.stop();
      await releaseWorkspaceProviderCoordinator(coordinatorOwner, paths);
    }
  } catch (error) {
    return failure('scheduled_task_instruction_create', error);
  }
}

export async function listTaskRecords(paths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  const tasks = await listScheduledTasks(paths);
  return {
    ok: true,
    action: 'scheduled_task_list',
    changed: false,
    message: 'Listed scheduled tasks.',
    tasks: await Promise.all(
      tasks.map(async (task) => ({
        ...task,
        activeRun: await readActiveScheduledTaskRun(task.id, paths),
        lastRun: await readLatestScheduledTaskRun(task.id, paths),
      })),
    ),
  } as const;
}

export async function readTaskRecord(id: string, paths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  const task = await readScheduledTask(id, paths);
  if (!task) {
    return {
      ok: false,
      action: 'scheduled_task_read',
      changed: false,
      message: `Scheduled task "${id}" was not found.`,
    } as const;
  }
  return {
    ok: true,
    action: 'scheduled_task_read',
    changed: false,
    message: `Read scheduled task "${id}".`,
    task,
    activeRun: await readActiveScheduledTaskRun(id, paths),
    run: await readLatestScheduledTaskRun(id, paths),
  } as const;
}

export async function listTaskRunRecords(id: string, paths = runtimePaths()) {
  const task = await readScheduledTask(id, paths);
  if (!task)
    return failure(
      'scheduled_task_runs_list',
      `Scheduled task "${id}" was not found.`,
    );
  return {
    ok: true,
    action: 'scheduled_task_runs_list',
    changed: false,
    message: `Listed runs for scheduled task "${id}".`,
    runs: await listScheduledTaskRuns(id, paths),
  } as const;
}

export async function readTaskRunRecord(runId: string, paths = runtimePaths()) {
  const run = await readScheduledTaskRun(runId, paths);
  if (!run)
    return failure(
      'scheduled_task_run_read',
      `Scheduled task run "${runId}" was not found.`,
    );
  return {
    ok: true,
    action: 'scheduled_task_run_read',
    changed: false,
    message: `Read scheduled task run "${runId}".`,
    run,
    ...(await scheduledRunWorkspaceDetail(runId, paths)),
  } as const;
}

export async function scheduleTaskNow(id: string, paths = runtimePaths()) {
  const changed = await makeScheduledTaskDue(id, paths);
  if (!changed)
    return failure(
      'scheduled_task_run_now',
      `Scheduled task "${id}" was not found or is already running.`,
    );
  return {
    ok: true,
    action: 'scheduled_task_run_now',
    changed: true,
    message: `Scheduled task "${id}" is due now.`,
  } as const;
}

export async function retainTaskRunWorkspace(
  runId: string,
  paths = runtimePaths(),
) {
  const detail = await scheduledRunWorkspaceDetail(runId, paths);
  if (!detail.workspace)
    return failure(
      'scheduled_workspace_retain',
      `Run "${runId}" has no workspace.`,
    );
  if (
    detail.workspace.lockOwner ||
    ['provisioning', 'preparing', 'ready', 'active', 'collecting'].includes(
      detail.workspace.status,
    )
  ) {
    return failure(
      'scheduled_workspace_retain',
      'Workspace retention can be changed after the active run settles.',
    );
  }
  const workspace = await retainTaskWorkspace(
    detail.workspace.id,
    runId,
    'Retained explicitly by the operator.',
    paths,
  );
  if (!workspace) {
    return failure(
      'scheduled_workspace_retain',
      'The workspace has been rebound to another occurrence or is currently active.',
    );
  }
  return {
    ok: true,
    action: 'scheduled_workspace_retain',
    changed: true,
    message: `Retained workspace for run "${runId}".`,
    workspace,
  } as const;
}

export async function cleanupTaskRunWorkspace(
  runId: string,
  rawInput: unknown,
  paths = runtimePaths(),
) {
  const parsed = v.safeParse(
    v.object({ confirm: v.optional(v.boolean()) }),
    rawInput,
  );
  if (!parsed.success || parsed.output.confirm !== true) {
    return {
      ok: false,
      action: 'scheduled_workspace_cleanup',
      changed: false,
      message: 'Workspace cleanup or detach requires explicit confirmation.',
      requires: ['confirm'],
    };
  }
  const detail = await scheduledRunWorkspaceDetail(runId, paths);
  if (!detail.workspace)
    return failure(
      'scheduled_workspace_cleanup',
      `Run "${runId}" has no workspace.`,
    );
  if (
    detail.workspace.lockOwner ||
    ['provisioning', 'preparing', 'ready', 'active', 'collecting'].includes(
      detail.workspace.status,
    )
  ) {
    return failure(
      'scheduled_workspace_cleanup',
      'Workspace cleanup is blocked while the workspace is active or leased. Wait for run settlement before cleaning it up.',
    );
  }
  let workspace;
  try {
    workspace = await cleanupScheduledWorkspace(detail.workspace.id, paths, {
      owningRunId: runId,
    });
  } catch (error) {
    return failure('scheduled_workspace_cleanup', error);
  }
  return {
    ok: workspace?.status === 'deleted',
    action: 'scheduled_workspace_cleanup',
    changed: workspace?.status === 'deleted',
    message:
      workspace?.status === 'deleted'
        ? detail.workspace.lifecycle === 'existing'
          ? `Detached existing workspace from run "${runId}" without deleting provider infrastructure.`
          : `Cleaned up workspace for run "${runId}".`
        : 'Workspace cleanup is pending; inspect the provider error before retrying.',
    workspace,
  } as const;
}

export async function listScheduledWorkspaceQuarantines(
  paths = runtimePaths(),
) {
  return {
    ok: true as const,
    action: 'scheduled_workspace_quarantine_list',
    changed: false,
    message: 'Listed durable physical-workspace quarantines.',
    quarantines: await listPhysicalWorkspaceQuarantines(paths),
  };
}

export async function clearScheduledWorkspaceQuarantine(
  rawInput: unknown,
  paths = runtimePaths(),
) {
  const parsed = v.safeParse(
    scheduledWorkspaceQuarantineClearInputSchema,
    rawInput,
  );
  if (!parsed.success || parsed.output.confirm !== true) {
    return {
      ok: false as const,
      action: 'scheduled_workspace_quarantine_clear',
      changed: false,
      message:
        'Clearing an uncertain remote-operation quarantine requires explicit confirmation that no process is still mutating the resource.',
      requires: ['confirm'],
    };
  }
  const cleared = await clearPhysicalWorkspaceQuarantine(
    parsed.output.physicalResourceKey,
    paths,
  );
  return cleared
    ? {
        ok: true as const,
        action: 'scheduled_workspace_quarantine_clear',
        changed: true,
        message: 'Cleared the physical-workspace quarantine.',
      }
    : {
        ok: false as const,
        action: 'scheduled_workspace_quarantine_clear',
        changed: false,
        message:
          'The quarantine was not found or the physical workspace still has an active lease.',
        requires: ['settlement'],
      };
}

export async function setTaskEnabled(
  id: string,
  enabled: boolean,
  paths = runtimePaths(),
) {
  const existing = await readScheduledTask(id, paths);
  if (existing?.spec.kind === 'poll-pr-watch') {
    return {
      ok: false,
      action: 'scheduled_task_enabled_update',
      changed: false,
      message:
        'PR watch tasks are managed by their watch and cannot be paused directly.',
      requires: ['watch'],
    } as const;
  }
  const task = await setScheduledTaskEnabled(id, enabled, paths);
  if (!task) {
    return {
      ok: false,
      action: 'scheduled_task_enabled_update',
      changed: false,
      message: `Scheduled task "${id}" was not found.`,
    } as const;
  }
  return success(
    'scheduled_task_enabled_update',
    task,
    `${enabled ? 'Enabled' : 'Paused'} scheduled task "${id}".`,
  );
}

export async function removeTask(id: string, paths = runtimePaths()) {
  const task = await readScheduledTask(id, paths);
  if (!task) {
    return {
      ok: false,
      action: 'scheduled_task_delete',
      changed: false,
      message: `Scheduled task "${id}" was not found.`,
    } as const;
  }
  if (task.spec.kind === 'poll-pr-watch') {
    return {
      ok: false,
      action: 'scheduled_task_delete',
      changed: false,
      message:
        'PR watch tasks are managed by their watch and cannot be deleted directly.',
      requires: ['watch'],
    } as const;
  }
  const deleted = await deleteScheduledTask(id, paths);
  if (!deleted) {
    return failure(
      'scheduled_task_delete',
      'Scheduled task deletion is blocked while a run is active or a linked workspace still exists. Pause the task, wait for settlement, then retain or clean up every workspace before deleting it.',
    );
  }
  return success(
    'scheduled_task_delete',
    task,
    `Deleted scheduled task "${id}".`,
  );
}

function success(
  action: string,
  task: unknown,
  message: string,
): ScheduledTaskActionResult {
  return { ok: true, action, changed: true, message, task: asJsonValue(task) };
}

function invalidResult(
  action: string,
  parsed: { issues?: v.BaseIssue<unknown>[] },
): ScheduledTaskActionResult {
  return {
    ok: false,
    action,
    changed: false,
    message: 'Invalid scheduled task input.',
    errors:
      parsed.issues && parsed.issues.length > 0
        ? [
            v.summarize(
              parsed.issues as [
                v.BaseIssue<unknown>,
                ...v.BaseIssue<unknown>[],
              ],
            ),
          ]
        : undefined,
  };
}

function failure(action: string, error: unknown): ScheduledTaskActionResult {
  return {
    ok: false,
    action,
    changed: false,
    message: sanitizedBoundedContent(
      error instanceof Error ? error.message : String(error),
      16 * 1024,
    ).content,
  };
}

function pastOneShotTriggerMessage(
  trigger: v.InferOutput<typeof automationTriggerSchema>,
) {
  if (trigger.kind !== 'once' || Date.parse(trigger.at) > Date.now()) {
    return undefined;
  }
  return 'One-shot scheduled tasks must be scheduled in the future.';
}
