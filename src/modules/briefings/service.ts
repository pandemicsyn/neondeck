import {
  dispatch,
  type DispatchReceipt,
  type FlueObservation,
} from '@flue/runtime';
import * as v from 'valibot';
import type { RuntimePaths } from '../../runtime-home';
import { runtimePaths } from '../../runtime-home';
import { addNotification, listNotifications } from '../app-state';
import {
  createChatSession,
  publishSessionEvent,
  readChatSession,
  updateChatSessionCommandEvent,
} from '../sessions';
import {
  briefingProfileUpdateSchema,
  briefingRunNowSchema,
  defaultBriefingProfileId,
  type BriefingProfile,
  type BriefingRun,
} from './schemas';
import {
  collectBriefingSnapshot,
  type BriefingSnapshotDependencies,
} from './snapshot';
import {
  attachBriefingDispatch,
  attachBriefingWorkflowRun,
  createBriefingRun,
  failBriefingRunBeforeDispatch,
  listBriefingRunMetadata,
  readBriefingRun,
  readBriefingRunByDispatch,
  readBriefingProfile,
  setBriefingProfileSession,
  settleBriefingRun,
  writeBriefingProfileAndTask,
} from './store';

type BriefingServiceDependencies = BriefingSnapshotDependencies & {
  dispatchAgent?: (request: {
    agent: string;
    id: string;
    input: string;
  }) => Promise<DispatchReceipt>;
  invokeWorkflow?: (input: {
    profileId: string;
    sessionId?: string;
    commandEventId?: string;
    trigger: 'manual' | 'dashboard';
  }) => Promise<{ runId: string }>;
};

type BriefingTerminal = {
  failed: boolean;
  error: string | null;
  instanceId: string;
  recordedAt: number;
};
const pendingBriefingTerminals = new Map<string, BriefingTerminal>();
const pendingTerminalTtlMs = 30_000;

export async function readBriefingState(paths: RuntimePaths = runtimePaths()) {
  const profile = await readBriefingProfile(defaultBriefingProfileId, paths);
  const [runs, notifications, linkedSession] = await Promise.all([
    listBriefingRunMetadata(paths),
    listNotifications(paths),
    profile.sessionId
      ? readChatSession(
          { id: profile.sessionId, reason: 'briefing-state-read' },
          paths,
        )
      : null,
  ]);
  const session =
    linkedSession && 'session' in linkedSession ? linkedSession.session : null;
  return {
    ok: true,
    action: 'briefing_state_read',
    changed: false,
    profile,
    latestRun: runs[0] ?? null,
    runs,
    sessionStaleReasons: session?.staleReasons ?? [],
    unreadCount: notifications.filter(
      (notification) =>
        notification.source === 'briefing' && !notification.readAt,
    ).length,
    fetchedAt: new Date().toISOString(),
  } as const;
}

export async function rotateBriefingSession(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
) {
  const parsed = v.safeParse(
    v.object({ id: v.optional(v.string()) }),
    rawInput,
  );
  if (!parsed.success) {
    return {
      ok: false,
      action: 'briefing_session_rotate',
      changed: false,
      message: 'Invalid briefing session rotation request.',
    } as const;
  }
  const profile = await readBriefingProfile(
    parsed.output.id ?? defaultBriefingProfileId,
    paths,
  );
  if (profile.compatibility) {
    await writeBriefingProfileAndTask(
      {
        id: profile.id,
        name: profile.name,
        enabled: profile.enabled,
        instructions: profile.instructions,
        instructionsVersion: profile.instructionsVersion,
        schedule: profile.schedule,
        timezone: profile.timezone,
        sessionId: null,
      },
      paths,
    );
  }
  const created = await createChatSession(
    {
      title: profile.name,
      kind: 'briefing',
      linkedTaskId: `briefing:${profile.id}:rotation:${Date.now()}`,
      activate: false,
      surface: 'dashboard',
      reason: 'explicit-briefing-session-rotation',
      uiMetadata: { briefingProfileId: profile.id },
    },
    paths,
  );
  if (!('session' in created)) {
    return {
      ok: false,
      action: 'briefing_session_rotate',
      changed: false,
      message: 'A fresh briefing conversation could not be created.',
    } as const;
  }
  await setBriefingProfileSession(profile.id, created.session.id, paths);
  const updated = await readBriefingProfile(profile.id, paths);
  return {
    ok: true,
    action: 'briefing_session_rotate',
    changed: true,
    message: 'Started a fresh briefing conversation.',
    profile: updated,
    session: created.session,
  } as const;
}

export async function readBriefingRunDetails(
  id: string,
  paths: RuntimePaths = runtimePaths(),
) {
  const run = await readBriefingRun(id, paths);
  if (!run) {
    return {
      ok: false,
      action: 'briefing_run_read',
      changed: false,
      message: `Briefing run "${id}" was not found.`,
    } as const;
  }
  return {
    ok: true,
    action: 'briefing_run_read',
    changed: false,
    message: `Read briefing run "${id}".`,
    run,
  } as const;
}

export async function updateBriefingProfile(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
) {
  const parsed = v.safeParse(briefingProfileUpdateSchema, rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      action: 'briefing_profile_update',
      changed: false,
      message: 'Invalid briefing profile.',
      errors: [v.summarize(parsed.issues)],
    } as const;
  }
  const id = parsed.output.id ?? defaultBriefingProfileId;
  const current = await readBriefingProfile(id, paths);
  const instructions = parsed.output.instructions ?? current.instructions;
  const desired = {
    id,
    name: parsed.output.name ?? current.name,
    enabled: parsed.output.enabled ?? current.enabled,
    instructions,
    instructionsVersion:
      instructions === current.instructions
        ? current.instructionsVersion
        : current.instructionsVersion + 1,
    schedule: parsed.output.schedule ?? current.schedule,
    timezone: parsed.output.timezone ?? current.timezone,
    sessionId: current.sessionId,
  };
  try {
    const updated = await writeBriefingProfileAndTask(desired, paths);
    return {
      ok: true,
      action: 'briefing_profile_update',
      changed: true,
      message: 'Updated the morning briefing profile and schedule.',
      profile: updated.profile,
      task: updated.task,
    } as const;
  } catch (error) {
    return {
      ok: false,
      action: 'briefing_profile_update',
      changed: false,
      message: `The briefing profile was not changed: ${error instanceof Error ? error.message : String(error)}`,
    } as const;
  }
}

export async function runBriefingNow(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
  dependencies: BriefingServiceDependencies = {},
) {
  const parsed = v.safeParse(briefingRunNowSchema, rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      action: 'briefing_run',
      changed: false,
      message: 'Invalid briefing run request.',
      errors: [v.summarize(parsed.issues)],
    } as const;
  }
  try {
    const input = {
      profileId: parsed.output.profileId ?? defaultBriefingProfileId,
      sessionId: parsed.output.sessionId,
      commandEventId: parsed.output.commandEventId,
      trigger: parsed.output.trigger ?? ('dashboard' as const),
    };
    const invokeWorkflow =
      dependencies.invokeWorkflow ?? invokeBriefingWorkflow;
    const { runId } = await invokeWorkflow(input);
    return {
      ok: true,
      action: 'briefing_run',
      changed: true,
      message: `Briefing workflow ${runId} queued.`,
      workflowRunId: runId,
    } as const;
  } catch (error) {
    return {
      ok: false,
      action: 'briefing_run',
      changed: false,
      message: error instanceof Error ? error.message : String(error),
    } as const;
  }
}

async function invokeBriefingWorkflow(input: {
  profileId: string;
  sessionId?: string;
  commandEventId?: string;
  trigger: 'manual' | 'dashboard';
}) {
  const { invoke } = await import('@flue/runtime');
  const workflow = await import('../../workflows/briefing');
  return invoke(workflow.default, { input });
}

export async function admitBriefing(
  input: {
    profileId: string;
    trigger: BriefingRun['trigger'];
    sessionId?: string;
    commandEventId?: string;
  },
  paths: RuntimePaths = runtimePaths(),
  dependencies: BriefingServiceDependencies = {},
) {
  const profile = await readBriefingProfile(input.profileId, paths);
  const sessionId = input.sessionId
    ? await validateRequestedBriefingSession(input.sessionId, paths)
    : await resolveScheduledBriefingSession(profile, paths);
  const snapshot = await collectBriefingSnapshot(paths, dependencies);
  const run = await createBriefingRun(
    {
      profileId: profile.id,
      trigger: input.trigger,
      snapshot,
      instructions: profile.instructions,
      instructionsVersion: profile.instructionsVersion,
      sessionId,
      commandEventId: input.commandEventId,
    },
    paths,
  );
  if (!run) throw new Error('Briefing run could not be persisted.');

  try {
    const dispatchAgent = dependencies.dispatchAgent ?? dispatch;
    const receipt = await dispatchAgent({
      agent: 'display-assistant',
      id: sessionId,
      input: composeBriefingInput(run, profile),
    });
    await attachBriefingDispatch(run.id, receipt.dispatchId, paths);
    await reconcilePendingBriefingTerminal(receipt.dispatchId, paths);
    return { ...run, dispatchId: receipt.dispatchId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failBriefingRunBeforeDispatch(run.id, message, paths);
    await addNotification(
      {
        level: 'attention',
        title: 'Morning briefing failed',
        message: 'Neon could not start the briefing conversation.',
        source: 'briefing',
        sourceId: run.id,
        data: { runId: run.id, sessionId, error: message },
      },
      paths,
    );
    throw error;
  }
}

export async function settleBriefingObservation(
  event: Extract<
    FlueObservation,
    { type: 'agent_end' | 'operation' | 'submission_settled' }
  >,
  paths: RuntimePaths = runtimePaths(),
) {
  if (!event.dispatchId) return null;
  const observation = event as unknown as Record<string, unknown>;
  if (observation.taskId || observation.parentSession) return null;
  if (
    typeof observation.agentName === 'string' &&
    observation.agentName !== 'display-assistant'
  ) {
    return null;
  }
  if (
    event.type === 'operation' &&
    (event.operationKind !== 'prompt' || !event.isError)
  ) {
    return null;
  }
  const failed =
    event.type === 'operation'
      ? event.isError
      : event.type === 'submission_settled'
        ? event.outcome !== 'completed'
        : false;
  const error = failed ? briefingObservationError(event) : null;
  const instanceId =
    typeof observation.instanceId === 'string' ? observation.instanceId : '';
  let correlated = await readBriefingRunByDispatch(event.dispatchId, paths);
  if (!correlated) {
    const runId = briefingRunIdFromObservation(observation);
    if (runId) {
      const candidate = await readBriefingRun(runId, paths);
      if (
        candidate?.status === 'queued' &&
        (!instanceId || candidate.sessionId === instanceId)
      ) {
        await attachBriefingDispatch(runId, event.dispatchId, paths);
        correlated = await readBriefingRunByDispatch(event.dispatchId, paths);
      }
    }
  }
  if (!correlated) {
    rememberPendingBriefingTerminal(paths, event.dispatchId, {
      failed,
      error,
      instanceId,
      recordedAt: Date.now(),
    });
    return null;
  }
  if (instanceId && correlated.sessionId !== instanceId) return null;
  return finalizeBriefingTerminal(
    event.dispatchId,
    { failed, error, instanceId, recordedAt: Date.now() },
    paths,
  );
}

async function finalizeBriefingTerminal(
  dispatchId: string,
  terminal: BriefingTerminal,
  paths: RuntimePaths,
) {
  const { failed, error } = terminal;
  const settled = await settleBriefingRun(
    dispatchId,
    failed ? 'failed' : 'ready',
    error,
    paths,
  );
  if (!settled.changed || !settled.run) return settled.run;

  const run = settled.run;
  if (run.commandEventId) {
    await updateChatSessionCommandEvent(
      {
        sessionId: run.sessionId,
        eventId: run.commandEventId,
        status: failed ? 'failed' : 'completed',
        result: null,
        reason: 'briefing-submission-settled',
      },
      paths,
    );
  }
  await addNotification(
    {
      level: failed ? 'attention' : 'ready',
      title: failed ? 'Morning briefing failed' : 'Morning briefing ready',
      message: failed
        ? 'Neon could not complete the briefing. Open the conversation for context.'
        : "Neon has added today's briefing to your Morning Briefing conversation.",
      source: 'briefing',
      sourceId: run.id,
      data: { runId: run.id, sessionId: run.sessionId },
    },
    paths,
  );
  const sessionResult = await readChatSession(
    { id: run.sessionId, reason: 'briefing-submission-settled' },
    paths,
  );
  if ('session' in sessionResult && sessionResult.session) {
    publishSessionEvent('updated', sessionResult.session, null);
  }
  return run;
}

function briefingObservationError(
  event: Extract<
    FlueObservation,
    { type: 'agent_end' | 'operation' | 'submission_settled' }
  >,
) {
  if (event.type === 'submission_settled') {
    return event.error?.message ?? `Briefing submission ${event.outcome}.`;
  }
  if (event.type === 'operation') {
    if (event.error instanceof Error) return event.error.message;
    if (typeof event.error === 'string') return event.error;
    return event.errorInfo?.message ?? 'Briefing model operation failed.';
  }
  return null;
}

export async function linkBriefingWorkflowObservation(
  event: Extract<FlueObservation, { type: 'run_end' }>,
  paths: RuntimePaths = runtimePaths(),
) {
  if (
    !('result' in event) ||
    !event.result ||
    typeof event.result !== 'object'
  ) {
    return;
  }
  const briefingRunId = (event.result as Record<string, unknown>).briefingRunId;
  if (typeof briefingRunId === 'string') {
    await attachBriefingWorkflowRun(briefingRunId, event.runId, paths);
  }
}

export function composeBriefingInput(
  run: BriefingRun,
  profile: BriefingProfile,
) {
  const triggerLabel =
    run.trigger === 'scheduled' ? 'scheduled morning' : 'manual';
  return [
    `[NEONDECK_INTERNAL_BRIEFING_INPUT v1 trigger=${run.trigger} run=${run.id}]`,
    `Prepare the ${triggerLabel} briefing for ${run.snapshot.collectedAt}.`,
    `Briefing snapshot id: ${run.id}.`,
    'Neondeck fact snapshot:',
    JSON.stringify(run.snapshot, null, 2),
    'User briefing instructions:',
    profile.instructions,
    'Respond to the user normally in this conversation. Use any configured MCP tools relevant to their instructions; do not assume a named external source was consulted unless you actually used it. If a deterministic or MCP source is unavailable, needs login, is denied, or awaits approval, explain that naturally and continue with the useful context you do have. Distinguish observed facts from inference. This briefing is informational; do not mutate external systems or auto-approve tool calls.',
  ].join('\n\n');
}

function briefingRunIdFromObservation(observation: Record<string, unknown>) {
  const agentInput = observation.agentInput;
  if (!agentInput || typeof agentInput !== 'object') return null;
  const raw = (agentInput as Record<string, unknown>).text;
  if (typeof raw !== 'string') return null;
  let text = raw;
  if (raw.startsWith('"')) {
    try {
      const decoded = JSON.parse(raw) as unknown;
      if (typeof decoded === 'string') text = decoded;
    } catch {
      return null;
    }
  }
  return (
    text.match(
      /\[NEONDECK_INTERNAL_BRIEFING_INPUT v1 trigger=\w+ run=([^\]\s]+)\]/,
    )?.[1] ?? null
  );
}

function pendingTerminalKey(paths: RuntimePaths, dispatchId: string) {
  return `${paths.home}:${dispatchId}`;
}

function rememberPendingBriefingTerminal(
  paths: RuntimePaths,
  dispatchId: string,
  terminal: BriefingTerminal,
) {
  const cutoff = Date.now() - pendingTerminalTtlMs;
  for (const [key, value] of pendingBriefingTerminals) {
    if (value.recordedAt < cutoff) pendingBriefingTerminals.delete(key);
  }
  if (pendingBriefingTerminals.size >= 100) {
    const oldest = pendingBriefingTerminals.keys().next().value;
    if (oldest) pendingBriefingTerminals.delete(oldest);
  }
  pendingBriefingTerminals.set(pendingTerminalKey(paths, dispatchId), terminal);
}

async function reconcilePendingBriefingTerminal(
  dispatchId: string,
  paths: RuntimePaths,
) {
  const key = pendingTerminalKey(paths, dispatchId);
  const terminal = pendingBriefingTerminals.get(key);
  if (!terminal) return;
  pendingBriefingTerminals.delete(key);
  if (Date.now() - terminal.recordedAt > pendingTerminalTtlMs) return;
  const run = await readBriefingRunByDispatch(dispatchId, paths);
  if (!run || (terminal.instanceId && run.sessionId !== terminal.instanceId)) {
    return;
  }
  await finalizeBriefingTerminal(dispatchId, terminal, paths);
}

async function resolveScheduledBriefingSession(
  profile: BriefingProfile,
  paths: RuntimePaths,
) {
  if (profile.sessionId) {
    const existing = await readChatSession(
      { id: profile.sessionId, reason: 'scheduled-briefing-reuse' },
      paths,
    );
    if ('session' in existing && !existing.session.archivedAt) {
      if (existing.session.staleReasons.length > 0) {
        throw new Error(
          'The briefing conversation context is stale. Start a fresh briefing conversation before running again.',
        );
      }
      return profile.sessionId;
    }
  }

  if (profile.compatibility) {
    await writeBriefingProfileAndTask(
      {
        id: profile.id,
        name: profile.name,
        enabled: profile.enabled,
        instructions: profile.instructions,
        instructionsVersion: profile.instructionsVersion,
        schedule: profile.schedule,
        timezone: profile.timezone,
        sessionId: null,
      },
      paths,
    );
  }

  const created = await createChatSession(
    {
      title: profile.name,
      kind: 'briefing',
      linkedTaskId: `briefing:${profile.id}`,
      activate: false,
      surface: 'dashboard',
      reason: 'scheduled-briefing-session',
      uiMetadata: { briefingProfileId: profile.id },
    },
    paths,
  );
  if (!('session' in created)) {
    throw new Error('Briefing session could not be created.');
  }
  if (created.session.staleReasons.length > 0) {
    throw new Error(
      'The briefing conversation context is stale. Start a fresh briefing conversation before running again.',
    );
  }
  await setBriefingProfileSession(profile.id, created.session.id, paths);
  return created.session.id;
}

async function validateRequestedBriefingSession(
  sessionId: string,
  paths: RuntimePaths,
) {
  const result = await readChatSession(
    { id: sessionId, reason: 'manual-briefing-admission' },
    paths,
  );
  if (
    !('session' in result) ||
    result.session.archivedAt ||
    result.session.agentName !== 'display-assistant' ||
    result.session.staleReasons.length > 0
  ) {
    throw new Error(
      'Manual briefings require an active display-assistant chat session.',
    );
  }
  return result.session.id;
}
