import {
  dispatch,
  type DispatchReceipt,
  type FlueObservation,
} from '@flue/runtime';
import type { FlueConversationSnapshot } from '@flue/sdk';
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
  type BriefingClientData,
  type BriefingDisplayContextBinding,
  type BriefingProfile,
  type BriefingRun,
} from './schemas';
import {
  collectBriefingSnapshot,
  type BriefingSnapshotDependencies,
} from './snapshot';
import {
  attachBriefingDispatch,
  BriefingAdmissionConflictError,
  createBriefingRun,
  failBriefingRunBeforeDispatch,
  findActiveBriefingRun,
  listBriefingRunMetadata,
  listQueuedBriefingRuns,
  markBriefingAdmissionUncertain,
  readBriefingRun,
  readBriefingRunByDispatch,
  readBriefingProfile,
  setBriefingProfileSession,
  settleBriefingRun,
  writeBriefingProfileAndTask,
} from './store';
import { settleDisplaySessionContextSnapshotSync } from '../sessions';

type BriefingServiceDependencies = BriefingSnapshotDependencies & {
  dispatchAgent?: (request: {
    agent: string;
    id: string;
    input: string;
    idempotencyKey: string;
  }) => Promise<DispatchReceipt>;
  attachDispatch?: (
    runId: string,
    submissionId: string,
    paths: RuntimePaths,
  ) => Promise<BriefingRun | null>;
  readConversationHistory?: (
    sessionId: string,
  ) => Promise<FlueConversationSnapshot | null>;
};

type BriefingRecoveryDependencies = BriefingServiceDependencies & {
  readConversationHistory: (
    sessionId: string,
  ) => Promise<FlueConversationSnapshot | null>;
};

type BriefingTerminal = {
  failed: boolean;
  error: string | null;
  instanceId: string;
  recordedAt: number;
};
const pendingBriefingTerminals = new Map<string, BriefingTerminal>();
const pendingTerminalTtlMs = 30_000;
const activeBriefingAdmissions = new Map<string, Promise<BriefingRun>>();
const briefingHistoryReaders = new Map<
  string,
  (sessionId: string) => Promise<FlueConversationSnapshot | null>
>();

export function installBriefingConversationHistoryReader(
  paths: RuntimePaths,
  reader: (sessionId: string) => Promise<FlueConversationSnapshot | null>,
) {
  briefingHistoryReaders.set(paths.neondeckDatabase, reader);
}

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
    const run = await admitBriefing(input, paths, dependencies);
    if (!run.dispatchId) {
      throw new Error('Briefing submission was not recorded.');
    }
    return {
      ok: true,
      action: 'briefing_run',
      changed: true,
      message: run.admissionReconciliationPending
        ? `Flue accepted briefing ${run.id}; Neondeck will reconcile its durable submission record before another briefing is admitted.`
        : `Briefing ${run.id} queued in its conversation.`,
      briefingRunId: run.id,
      submissionId: run.dispatchId,
      sessionId: run.sessionId,
      run,
    } as const;
  } catch (error) {
    if (parsed.output.sessionId && parsed.output.commandEventId) {
      try {
        await updateChatSessionCommandEvent(
          {
            sessionId: parsed.output.sessionId,
            eventId: parsed.output.commandEventId,
            status: 'failed',
            result: null,
            reason: 'briefing-admission-failed',
          },
          paths,
        );
      } catch {
        // Preserve the original admission failure for the caller.
      }
    }
    return {
      ok: false,
      action: 'briefing_run',
      changed: false,
      message: error instanceof Error ? error.message : String(error),
    } as const;
  }
}

export async function admitBriefing(
  input: {
    profileId: string;
    trigger: BriefingRun['trigger'];
    sessionId?: string;
    commandEventId?: string;
    scheduledTaskRunId?: string;
  },
  paths: RuntimePaths = runtimePaths(),
  dependencies: BriefingServiceDependencies = {},
) {
  const profile = await readBriefingProfile(input.profileId, paths);
  const sessionId = input.sessionId
    ? await validateRequestedBriefingSession(input.sessionId, paths)
    : await resolveScheduledBriefingSession(profile, paths);
  const lockKey = `${paths.neondeckDatabase}\0${sessionId}`;
  const activeAdmission = activeBriefingAdmissions.get(lockKey);
  if (activeAdmission) {
    throw new BriefingAdmissionConflictError(
      'admission-in-progress',
      sessionId,
    );
  }
  const admission = admitBriefingLocked(
    { ...input, sessionId },
    profile,
    paths,
    dependencies,
  ).finally(() => {
    if (activeBriefingAdmissions.get(lockKey) === admission) {
      activeBriefingAdmissions.delete(lockKey);
    }
  });
  activeBriefingAdmissions.set(lockKey, admission);
  return admission;
}

async function admitBriefingLocked(
  input: {
    profileId: string;
    trigger: BriefingRun['trigger'];
    sessionId: string;
    commandEventId?: string;
    scheduledTaskRunId?: string;
  },
  profile: BriefingProfile,
  paths: RuntimePaths,
  dependencies: BriefingServiceDependencies,
) {
  const pending = await findActiveBriefingRun(
    { sessionId: input.sessionId },
    paths,
  );
  if (pending) {
    let submissionId = pending.dispatchId;
    if (!pending.dispatchId) {
      const pendingProfile = await readBriefingProfile(
        pending.profileId ?? defaultBriefingProfileId,
        paths,
      );
      const receipt = await dispatchPersistedBriefing(
        pending,
        pendingProfile,
        dependencies,
      );
      const attached = await recordBriefingAdmission(
        pending,
        receipt.submissionId,
        paths,
        dependencies,
      );
      submissionId = receipt.submissionId;
      if (attached) {
        await reconcileBriefingSettlementForAdmission(
          attached,
          receipt.submissionId,
          paths,
          dependencies.readConversationHistory,
        );
      }
    } else {
      await reconcileBriefingSettlementForAdmission(
        pending,
        pending.dispatchId,
        paths,
        dependencies.readConversationHistory,
      );
    }
    const stillActive = await findActiveBriefingRun(
      { sessionId: input.sessionId },
      paths,
    );
    if (stillActive) {
      throw new BriefingAdmissionConflictError(stillActive.id, input.sessionId);
    }
    if (submissionId) {
      await reconcilePendingBriefingTerminal(submissionId, paths);
    }
  }
  const snapshot = await collectBriefingSnapshot(paths, dependencies);
  const run = await createBriefingRun(
    {
      profileId: profile.id,
      trigger: input.trigger,
      snapshot,
      instructions: profile.instructions,
      instructionsVersion: profile.instructionsVersion,
      sessionId: input.sessionId,
      commandEventId: input.commandEventId,
      scheduledTaskRunId: input.scheduledTaskRunId,
    },
    paths,
  );
  if (!run) throw new Error('Briefing run could not be persisted.');

  let receipt: DispatchReceipt;
  try {
    receipt = await dispatchPersistedBriefing(run, profile, dependencies);
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
        data: { runId: run.id, sessionId: input.sessionId, error: message },
      },
      paths,
    );
    throw error;
  }

  const attached = await recordBriefingAdmission(
    run,
    receipt.submissionId,
    paths,
    dependencies,
  );
  return {
    ...(attached ?? run),
    dispatchId: receipt.submissionId,
    admissionReconciliationPending: !attached,
  };
}

async function reconcileBriefingSettlementForAdmission(
  run: BriefingRun,
  submissionId: string,
  paths: RuntimePaths,
  suppliedReader?: (
    sessionId: string,
  ) => Promise<FlueConversationSnapshot | null>,
) {
  try {
    return await reconcileBriefingSettlementFromHistory(
      run,
      submissionId,
      paths,
      suppliedReader,
    );
  } catch (error) {
    console.warn(
      '[neondeck] briefing history reconciliation will retry while admission remains fenced',
      error,
    );
    return null;
  }
}

async function dispatchPersistedBriefing(
  run: BriefingRun,
  profile: BriefingProfile,
  dependencies: BriefingServiceDependencies,
) {
  return dependencies.dispatchAgent
    ? dependencies.dispatchAgent({
        agent: 'display-assistant',
        id: run.sessionId,
        input: composeBriefingInput(run),
        idempotencyKey: run.id,
      })
    : dispatchBriefingSignal({ id: run.sessionId, run, profile });
}

async function recordBriefingAdmission(
  run: BriefingRun,
  submissionId: string,
  paths: RuntimePaths,
  dependencies: BriefingServiceDependencies,
) {
  let attached: BriefingRun | null = null;
  let attachmentError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      attached = await (dependencies.attachDispatch ?? attachBriefingDispatch)(
        run.id,
        submissionId,
        paths,
      );
      attachmentError = undefined;
      break;
    } catch (error) {
      attachmentError = error;
    }
  }
  if (attachmentError) {
    const message =
      attachmentError instanceof Error
        ? attachmentError.message
        : String(attachmentError);
    try {
      await markBriefingAdmissionUncertain(run.id, message, paths);
    } catch {
      // The persisted queued run remains the durable outbox even if annotating
      // the post-admission failure encounters the same database outage.
    }
    return null;
  }
  try {
    await markBriefingCommandRunning(attached ?? run, submissionId, paths);
  } catch (error) {
    console.warn(
      '[neondeck] briefing command correlation update failed',
      error,
    );
  }
  await reconcilePendingBriefingTerminal(submissionId, paths);
  return attached;
}

async function markBriefingCommandRunning(
  run: BriefingRun,
  submissionId: string,
  paths: RuntimePaths,
) {
  if (!run.commandEventId) return;
  await updateChatSessionCommandEvent(
    {
      sessionId: run.sessionId,
      eventId: run.commandEventId,
      status: 'running',
      flueRunId: submissionId,
      reason: 'briefing-submission-admitted',
    },
    paths,
  );
}

export async function recoverInterruptedBriefingAdmissions(
  dependencies: BriefingRecoveryDependencies,
  paths: RuntimePaths = runtimePaths(),
) {
  const pendingRuns = await listQueuedBriefingRuns(paths);
  const recovered: string[] = [];
  const dispatched: string[] = [];
  const failed: Array<{ runId: string; error: string }> = [];

  for (const run of pendingRuns) {
    try {
      const profile = await readBriefingProfile(
        run.profileId ?? defaultBriefingProfileId,
        paths,
      );
      const receipt = run.dispatchId
        ? null
        : await dispatchPersistedBriefing(run, profile, dependencies);
      const submissionId = run.dispatchId ?? receipt?.submissionId;
      if (!submissionId) {
        throw new Error('Flue did not return a briefing submission id.');
      }
      const attached = run.dispatchId
        ? run
        : await (dependencies.attachDispatch ?? attachBriefingDispatch)(
            run.id,
            submissionId,
            paths,
          );
      await markBriefingCommandRunning(attached ?? run, submissionId, paths);
      await reconcileBriefingSettlementFromHistory(
        attached ?? run,
        submissionId,
        paths,
        dependencies.readConversationHistory,
      );
      await reconcilePendingBriefingTerminal(submissionId, paths);
      (receipt && !receipt.deduplicated ? dispatched : recovered).push(run.id);
    } catch (error) {
      failed.push({
        runId: run.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { recovered, dispatched, failed };
}

export async function recoverRegisteredInterruptedBriefingAdmissions(
  paths: RuntimePaths = runtimePaths(),
) {
  const readConversationHistory = briefingHistoryReaders.get(
    paths.neondeckDatabase,
  );
  if (!readConversationHistory) {
    return { recovered: [], dispatched: [], failed: [] };
  }
  return recoverInterruptedBriefingAdmissions(
    { readConversationHistory },
    paths,
  );
}

async function reconcileBriefingSettlementFromHistory(
  run: BriefingRun,
  submissionId: string,
  paths: RuntimePaths,
  suppliedReader?: (
    sessionId: string,
  ) => Promise<FlueConversationSnapshot | null>,
) {
  const reader =
    suppliedReader ?? briefingHistoryReaders.get(paths.neondeckDatabase);
  if (!reader) return null;
  const history = await reader(run.sessionId);
  const settlement = history?.settlements.find(
    (item) => item.submissionId === submissionId,
  );
  if (!settlement) return null;
  return finalizeBriefingTerminal(
    submissionId,
    {
      failed: settlement.outcome !== 'completed',
      error:
        settlement.outcome === 'completed'
          ? null
          : settlementError(settlement.error, settlement.outcome),
      instanceId: run.sessionId,
      recordedAt: Date.now(),
    },
    paths,
  );
}

function settlementError(error: unknown, outcome: 'failed' | 'aborted') {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return `Briefing submission ${outcome}.`;
}

async function dispatchBriefingSignal(input: {
  id: string;
  run: BriefingRun;
  profile: BriefingProfile;
}) {
  const { DisplayAssistant } = await import('../../agents/display-assistant');
  return dispatch(DisplayAssistant, {
    id: input.id,
    idempotencyKey: input.run.id,
    message: {
      kind: 'signal',
      type: 'neondeck.briefing.ready',
      tagName: 'morning-briefing',
      body: `Persisted briefing ${input.run.id} is ready for grounded delivery.`,
      attributes: {
        briefingRunId: input.run.id,
        profileId: input.profile.id,
        snapshotVersion: String(input.run.snapshot.version),
      },
    },
  });
}

export async function settleBriefingObservation(
  event: Extract<FlueObservation, { type: 'submission_settled' }>,
  paths: RuntimePaths = runtimePaths(),
) {
  if (!event.submissionId) return null;
  const observation = event as unknown as Record<string, unknown>;
  if (observation.taskId || observation.parentSession) return null;
  if (
    typeof observation.agentName === 'string' &&
    observation.agentName !== 'display-assistant'
  ) {
    return null;
  }
  const failed = event.outcome !== 'completed';
  const error = failed ? briefingObservationError(event) : null;
  const instanceId =
    typeof observation.instanceId === 'string' ? observation.instanceId : '';
  let correlated = await readBriefingRunByDispatch(event.submissionId, paths);
  if (!correlated) {
    rememberPendingBriefingTerminal(paths, event.submissionId, {
      failed,
      error,
      instanceId,
      recordedAt: Date.now(),
    });
    return null;
  }
  if (instanceId && correlated.sessionId !== instanceId) return null;
  return finalizeBriefingTerminal(
    event.submissionId,
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
  const correlated = await readBriefingRunByDispatch(dispatchId, paths);
  if (!correlated) return null;
  if (!failed && correlated.contextSnapshotId) {
    await reconcileBriefingContextSettlement(correlated, dispatchId, paths);
  }
  const settled = await settleBriefingRun(
    dispatchId,
    failed ? 'failed' : 'ready',
    error,
    paths,
  );
  if (!settled.changed || !settled.run) return settled.run;

  const run = settled.run;
  const { settleScheduledTaskSubmission } = await import('../scheduled-tasks');
  await settleScheduledTaskSubmission(
    { submissionId: dispatchId, failed },
    paths,
  );
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

async function reconcileBriefingContextSettlement(
  run: BriefingRun,
  submissionId: string,
  paths: RuntimePaths,
) {
  const metadata = await readBriefingReplyMetadata(run.sessionId, submissionId);
  const binding = run.contextBinding;
  if (!binding || binding.snapshotId !== run.contextSnapshotId) {
    throw new Error(
      `Briefing run "${run.id}" settled without its exact display-context binding.`,
    );
  }
  if (!briefingContextModelWasAdopted(metadata, binding)) return;
  settleDisplaySessionContextSnapshotSync(
    {
      sessionId: run.sessionId,
      snapshotId: binding.snapshotId,
      capturedAt: binding.capturedAt,
      baselineSnapshotId: binding.baselineSnapshotId,
      baselineLoadedAt: binding.baselineLoadedAt,
      sessionContextFence: binding.sessionContextFence,
      configHistoryId: binding.configHistoryId,
      memoryEventSequence: binding.memoryEventSequence,
      memoryIds: binding.memoryIds,
      linkedContext: binding.linkedContext,
    },
    paths,
  );
}

async function readBriefingReplyMetadata(
  sessionId: string,
  submissionId: string,
) {
  const [{ init }, { DisplayAssistant }] = await Promise.all([
    import('@flue/runtime'),
    import('../../agents/display-assistant'),
  ]);
  return (await init(DisplayAssistant, { id: sessionId }).read(submissionId))
    .metadata;
}

export function briefingContextModelWasAdopted(
  metadata: Record<string, unknown> | undefined,
  binding: Pick<BriefingDisplayContextBinding, 'model' | 'thinkingLevel'>,
) {
  const value = metadata?.neondeckDisplayAssistant;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const started = value as Record<string, unknown>;
  return (
    started.model === binding.model &&
    started.thinkingLevel === binding.thinkingLevel
  );
}

function briefingObservationError(
  event: Extract<FlueObservation, { type: 'submission_settled' }>,
) {
  return event.error?.message ?? `Briefing submission ${event.outcome}.`;
}

export function composeBriefingInput(run: BriefingRun) {
  const triggerLabel =
    run.trigger === 'scheduled' ? 'scheduled morning' : 'manual';
  return [
    `[NEONDECK_INTERNAL_BRIEFING_INPUT v1 trigger=${run.trigger} run=${run.id}]`,
    `Prepare the ${triggerLabel} briefing for ${run.snapshot.collectedAt}.`,
    `Briefing snapshot id: ${run.id}.`,
    'Neondeck fact snapshot:',
    JSON.stringify(run.snapshot, null, 2),
    'User briefing instructions:',
    run.instructions,
    'Respond to the user normally in this conversation. Use any configured MCP tools relevant to their instructions; do not assume a named external source was consulted unless you actually used it. If a deterministic or MCP source is unavailable, needs login, is denied, or awaits approval, explain that naturally and continue with the useful context you do have. Distinguish observed facts from inference. This briefing is informational; do not mutate external systems or change MCP approval policy.',
  ].join('\n\n');
}

export async function prepareBriefingAgentDelivery(
  input: {
    runId: string;
    sessionId: string;
    profileId?: string;
    snapshotVersion?: string;
  },
  paths: RuntimePaths = runtimePaths(),
) {
  const run = await readBriefingRun(input.runId, paths);
  if (!run || run.status !== 'queued') {
    throw new Error(`Queued briefing "${input.runId}" was not found.`);
  }
  if (run.sessionId !== input.sessionId) {
    throw new Error('Briefing delivery does not match its bound conversation.');
  }
  if (input.profileId && run.profileId !== input.profileId) {
    throw new Error('Briefing delivery does not match its bound profile.');
  }
  if (
    input.snapshotVersion &&
    String(run.snapshot.version) !== input.snapshotVersion
  ) {
    throw new Error('Briefing delivery snapshot version does not match.');
  }
  return {
    prompt: composeBriefingInput(run),
    data: briefingClientData(run),
  };
}

export function briefingClientData(run: BriefingRun): BriefingClientData {
  const sourceHealth = Object.entries(run.snapshot.sources).map(
    ([name, source]) => ({
      name,
      status: source.status,
      truncated: source.truncated,
      ...(source.error ? { error: source.error } : {}),
    }),
  );
  return {
    briefingRunId: run.id,
    profileId: run.profileId,
    status: 'grounded',
    snapshotVersion: run.snapshot.version,
    collectedAt: run.snapshot.collectedAt,
    truncated: run.snapshot.truncated,
    sourceHealth,
    topActions: briefingTopActions(run).slice(0, 8),
    failures: sourceHealth
      .filter((source) => source.status !== 'ok')
      .map(
        (source) =>
          `${source.name}: ${source.error ?? `${source.status} source data`}`,
      ),
  };
}

function briefingTopActions(run: BriefingRun) {
  const actions: string[] = [];
  const notifications = objectValue(run.snapshot.sources.notifications?.data);
  for (const item of arrayValue(notifications?.items)) {
    const record = objectValue(item);
    const title = stringValue(record?.title);
    if (title) actions.push(title);
  }
  const reviewQueue = objectValue(run.snapshot.sources.reviewQueue?.data);
  for (const item of arrayValue(reviewQueue?.items)) {
    const record = objectValue(item);
    const repo = stringValue(record?.repo);
    const number = numberValue(record?.number);
    const title = stringValue(record?.title);
    if (repo && number !== null && title) {
      actions.push(`Review ${repo}#${number}: ${title}`);
    }
  }
  return [...new Set(actions)];
}

function objectValue(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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
      // Flue initializes the root harness for every submission, so the same
      // canonical conversation can load current runtime context in place.
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
    (result.session.staleReasons.length > 0 &&
      result.session.kind !== 'briefing')
  ) {
    throw new Error(
      'Manual briefings require an active display-assistant chat session.',
    );
  }
  return result.session.id;
}
