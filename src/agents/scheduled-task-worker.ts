'use agent';

import {
  type AgentProps,
  useDelivery,
  useModel,
  useResponseStart,
  useSandbox,
  useSkill,
} from '@flue/runtime';
import {
  readAgentModelSelectionSync,
  runtimeSkillFromSessionSnapshot,
} from '../modules/runtime';
import {
  readScheduledTaskRunSync,
  readTaskWorkspaceSync,
  assertScheduledWorkspaceRunAuthorizedSync,
  scheduledWorkspaceSandbox,
} from '../modules/scheduled-tasks';

export function ScheduledTaskWorker({ id }: AgentProps) {
  const delivery = useDelivery();
  if (
    delivery.kind !== 'signal' ||
    delivery.type !== 'neondeck.scheduled-workspace-instruction'
  ) {
    throw new Error(
      'Scheduled task worker accepts only workspace-bound schedule signals.',
    );
  }
  const workspaceId = delivery.attributes?.workspaceId;
  const runId = delivery.attributes?.runId;
  const cwd = delivery.attributes?.cwd;
  if (!workspaceId || !runId || !cwd) {
    throw new Error(
      'Scheduled workspace signal is missing workspace identity.',
    );
  }
  const workspace = readTaskWorkspaceSync(workspaceId);
  if (!workspace || workspace.status === 'deleted') {
    throw new Error(`Scheduled workspace "${workspaceId}" is unavailable.`);
  }
  const models = readAgentModelSelectionSync();
  const run = readScheduledTaskRunSync(runId);
  if (
    !run?.dispatchPayload ||
    run.dispatchPayload.workspaceId !== workspaceId ||
    run.dispatchPayload.runId !== runId ||
    !run.dispatchPayload.lockOwner
  ) {
    throw new Error(`Scheduled run "${runId}" has no matching dispatch state.`);
  }
  assertScheduledWorkspaceRunAuthorizedSync({
    workspaceId,
    runId,
    owner: run.dispatchPayload.lockOwner,
  });
  useModel(models.displayAssistant, {
    thinkingLevel: models.displayAssistantThinkingLevel,
    compaction: { reserveTokens: 10_000, keepRecentTokens: 8_000 },
  });
  useSandbox(
    scheduledWorkspaceSandbox(workspace, runId, run.dispatchPayload.lockOwner),
    { cwd },
  );
  for (const snapshot of run.dispatchPayload.skillSnapshots ?? []) {
    useSkill(runtimeSkillFromSessionSnapshot(snapshot));
  }
  useResponseStart(() => ({
    neondeckScheduledTask: {
      runId,
      workspaceId,
      providerId: workspace.providerId,
      authority: workspace.authority,
      baseSha: workspace.baseSha,
      branch: workspace.branchName,
    },
  }));
  return [
    'You are a bounded Neondeck scheduled-task worker operating in the declared repository workspace.',
    'Complete only the delivered instruction. Inspect repository guidance before changing files, run proportionate repository-native checks, and report concrete results and blockers.',
    'Do not schedule follow-up work. Do not access paths outside the mounted workspace. Never force-push, delete branches, reset or clean unresolved work, or remove provider infrastructure.',
    workspace.authority === 'read-only'
      ? 'This run is read-only. You have file inspection tools only; do not mutate the repository.'
      : 'You may edit files and run repository-native commands inside this workspace. Credentials are not provided. Commit only when the instruction explicitly asks for a commit.',
    workspace.authority === 'delivery-enabled'
      ? 'Delivery-enabled is an authority ceiling, not ambient push permission. No generic push credential is mounted; use only separately supplied bound delivery tools when present.'
      : 'Do not push or perform external delivery.',
    `Agent instance: ${id}. Workspace: ${workspace.workspaceRoot}.`,
  ].join('\n\n');
}

ScheduledTaskWorker.agentName = 'scheduled-task-worker';
ScheduledTaskWorker.durability = { maxAttempts: 5, timeoutMs: 3_600_000 };
