import type { JsonValue } from '@flue/runtime';
import {
  publishNotificationEvent,
  type AutomationExecutionResult,
} from '../app-state';
import { readRepoRegistrySnapshot } from '../repos';
import {
  repoAutopilotPolicyForWatch,
  type AutopilotMode,
} from '../autopilot-policy';
import {
  AutopilotPendingIntakeLeaseLostError,
  admitTerminalAutopilotOwnerCleanup,
  claimAutopilotTriageAdmission,
  coordinateAutopilotAdmission,
  reconcileAutopilotStageAttempts,
  type CoordinateAutopilotAdmissionResult,
  type AutopilotWorkflowInvoker,
} from '../autopilot';
import {
  acknowledgePrWatchEventIntake,
  listPrWatchEventWatermarks,
  readAddressedPrFeedback,
  readNeondeckPrDeliveries,
  refreshPrWatchEventState,
  type PrWatchEventWatermarkCategory,
  type PrWatchEventWatermarkRecord,
} from '../pr-events';
import {
  parseAppConfig,
  readRuntimeJson,
  type RuntimePaths,
} from '../../runtime-home';
import { listPrWatchRecords, type PrWatch } from '../watches';
import type { SchedulerDependencies } from './schemas';
import {
  deltasFromChangedCategories,
  initialActionableDeltas,
  prEventNotification,
  prEventSourceId,
  shouldAdmitTriageForDeltas,
  shouldRetainPendingTriage,
  snapshotFromWatermarks,
} from './pr-watch-event-deltas';
import { invokeScheduledWorkflow } from './workflow-invocation';
import {
  errorMessage,
  jsonRecord,
  readJsonArray,
  readJsonRecord,
  readObjectConfig,
  stringField,
} from './utils';

type WatchJobEventResult = {
  ok: boolean;
  changed: boolean;
  watchId: string;
  repoId: string;
  repoFullName: string;
  prNumber: number;
  mode?: AutopilotMode;
  changedCategories?: PrWatchEventWatermarkCategory[];
  deltas?: JsonValue[];
  message: string;
  refresh?: JsonValue;
  triage?: JsonValue;
  notifications?: AutomationExecutionResult['notifications'];
};
type PendingWatchTriageEvent = {
  eventId: string;
  input: Record<string, JsonValue>;
  reason: string;
};
type TriageAdmissionResult = {
  ok: boolean;
  changed: boolean;
  triage?: JsonValue;
  notifications: NonNullable<AutomationExecutionResult['notifications']>;
  message?: string;
  durablyAdmitted?: boolean;
  admissionId?: string;
};

const initialActionableCategories: PrWatchEventWatermarkCategory[] = [
  'review_threads',
  'requested_changes_reviews',
  'conversation_comments',
  'check_suites',
  'check_runs',
];

export async function refreshWatchJobEvents(
  results: Awaited<
    ReturnType<NonNullable<SchedulerDependencies['refreshPrWatch']>>
  >[],
  paths: RuntimePaths,
  dependencies: SchedulerDependencies,
  previousJobResult: JsonValue | null,
): Promise<WatchJobEventResult[]> {
  if (!dependencies.refreshPrWatchEventState && !process.env.GITHUB_TOKEN) {
    return [];
  }

  const pendingByWatch = pendingTriageEventsFromJobResult(previousJobResult);
  const watches = await listPrWatchRecords(paths);
  const watchById = new Map(watches.map((watch) => [watch.id, watch]));
  const invokeWorkflow = dependencies.invokeWorkflow ?? invokeScheduledWorkflow;
  const reconciliation = await reconcileAutopilotStageAttempts(paths);
  for (const admission of reconciliation.dueAdmissions) {
    const watch = watchById.get(admission.watchId);
    if (!watch) continue;
    const policy = await readEffectiveWatchAutopilotPolicy(watch, paths);
    if (!('concurrency' in policy) || policy.mode === 'notify-only') continue;
    await coordinateAutopilotAdmission(
      {
        admissionId: admission.id,
        limits: policy.concurrency,
        invokeWorkflow: autopilotWorkflowInvoker(invokeWorkflow),
        enableOwnerDispatch: true,
      },
      paths,
    );
  }
  const targetWatches = results
    .map((result) => watchIdFromResult(result))
    .filter((id): id is string => Boolean(id))
    .map((id) => watchById.get(id))
    .filter((watch): watch is PrWatch => Boolean(watch));

  const eventResults: WatchJobEventResult[] = [];
  for (const watch of targetWatches) {
    eventResults.push(
      await refreshOneWatchEvent(
        watch,
        paths,
        dependencies,
        pendingByWatch.get(watch.id) ?? [],
      ),
    );
  }

  return eventResults;
}

async function refreshOneWatchEvent(
  watch: PrWatch,
  paths: RuntimePaths,
  dependencies: SchedulerDependencies,
  pendingTriageEvents: PendingWatchTriageEvent[],
): Promise<WatchJobEventResult> {
  const listWatermarks =
    dependencies.listPrWatchEventWatermarks ?? listPrWatchEventWatermarks;
  const refreshEvents =
    dependencies.refreshPrWatchEventState ?? refreshPrWatchEventState;
  const previousResult = await listWatermarks({ watchId: watch.id }, paths);
  const acknowledgedWatermarks = watermarksFromActionResult(previousResult);
  const refresh = await refreshEvents({ watchId: watch.id }, paths);
  if (!refresh.ok) {
    const triage = triageValue(pendingTriageSnapshots(pendingTriageEvents));
    return {
      ok: false,
      changed: false,
      watchId: watch.id,
      repoId: watch.repoId,
      repoFullName: watch.repoFullName,
      prNumber: watch.prNumber,
      message: refresh.message,
      refresh: refresh as unknown as JsonValue,
      triage,
      notifications: [
        {
          level: 'attention',
          title: 'PR event refresh failed',
          message: refresh.message,
          source: 'watch-pr-events',
          sourceId: watch.id,
          data: refresh,
        },
      ],
    };
  }

  const changedCategories = changedCategoriesFromActionResult(refresh);
  const currentWatermarks = watermarksFromActionResult(refresh);
  const previousWatermarks =
    previousWatermarksFromActionResult(refresh) ?? acknowledgedWatermarks;
  const intakeId = intakeIdFromActionResult(refresh);
  if (seededUpgradeFromActionResult(refresh)) {
    return {
      ok: true,
      changed: false,
      watchId: watch.id,
      repoId: watch.repoId,
      repoFullName: watch.repoFullName,
      prNumber: watch.prNumber,
      changedCategories: [],
      message: refresh.message,
      refresh: refresh as unknown as JsonValue,
    };
  }
  const policy = await readEffectiveWatchAutopilotPolicy(watch, paths);
  const mode = policy.mode;
  const terminalSnapshot = snapshotFromWatermarks(currentWatermarks);
  if (isTerminalPrWithSettledChecks(terminalSnapshot)) {
    const cleanup = await admitTerminalAutopilotOwnerCleanup(
      { watchId: watch.id, reason: 'pull-request-terminal-state' },
      paths,
    );
    if (
      (cleanup.status === 'admitted' ||
        cleanup.status === 'already-admitted') &&
      'concurrency' in policy
    ) {
      await coordinateAutopilotAdmission(
        {
          admissionId: cleanup.admissionId,
          limits: policy.concurrency,
          invokeWorkflow: autopilotWorkflowInvoker(
            dependencies.invokeWorkflow ?? invokeScheduledWorkflow,
          ),
          enableOwnerDispatch: true,
        },
        paths,
      );
    }
  }
  if (!watch.initialEventProcessedAt) {
    return processInitialWatchEventState(
      watch,
      currentWatermarks,
      changedCategories,
      mode,
      policy,
      paths,
      dependencies,
      refresh as unknown as JsonValue,
      intakeId,
    );
  }
  if (changedCategories.length === 0) {
    if (pendingTriageEvents.length > 0) {
      if (mode === 'notify-only') {
        return preservedPendingWatchTriage(
          watch,
          pendingTriageEvents,
          refresh as unknown as JsonValue,
          mode,
        );
      }

      return retryPendingWatchTriage(
        watch,
        pendingTriageEvents,
        paths,
        dependencies,
        refresh as unknown as JsonValue,
        mode,
      );
    }

    return {
      ok: true,
      changed: false,
      watchId: watch.id,
      repoId: watch.repoId,
      repoFullName: watch.repoFullName,
      prNumber: watch.prNumber,
      message: refresh.message,
      refresh: refresh as unknown as JsonValue,
    };
  }

  const addressed = readAddressedPrFeedback(
    watch.repoFullName,
    watch.prNumber,
    paths,
  );
  let deliveries: ReturnType<typeof readNeondeckPrDeliveries>;
  try {
    deliveries = readNeondeckPrDeliveries(
      watch.repoFullName,
      watch.prNumber,
      paths,
    );
  } catch (error) {
    return invalidDeliveryLedgerResult(
      watch,
      changedCategories,
      mode,
      refresh as unknown as JsonValue,
      error,
    );
  }
  const deltas = deltasFromChangedCategories(
    changedCategories,
    currentWatermarks,
    previousWatermarks,
    {
      addressedReviewThreadFingerprints: addressed.reviewThreadFingerprints,
      addressedReviewCommentFingerprints: addressed.reviewCommentFingerprints,
      neondeckReviewCommentFingerprints: deliveries.reviewCommentFingerprints,
      neondeckRequestedChangesReviewFingerprints: deliveries.reviewFingerprints,
      neondeckConversationCommentFingerprints:
        deliveries.conversationCommentFingerprints,
    },
  );
  if (deltas.some((delta) => delta.type === 'incomplete-feedback')) {
    return {
      ok: false,
      changed: false,
      watchId: watch.id,
      repoId: watch.repoId,
      repoFullName: watch.repoFullName,
      prNumber: watch.prNumber,
      mode,
      changedCategories,
      deltas,
      message:
        'PR event facts are incomplete; the pending intake remains retryable and its watermark baseline was not acknowledged.',
      refresh: refresh as unknown as JsonValue,
    };
  }
  const current = snapshotFromWatermarks(currentWatermarks);
  const previous = snapshotFromWatermarks(previousWatermarks);
  const eventNotification = {
    ...prEventNotification(
      watch,
      changedCategories,
      currentWatermarks,
      deltas,
      mode,
    ),
    ...(intakeId ? { sourceId: intakeId } : {}),
  };
  if (mode === 'notify-only' && intakeId) {
    const delivery = await acknowledgeWatchEventIntake(
      watch,
      intakeId,
      'notification',
      paths,
      dependencies,
      { notification: eventNotification },
    );
    if (!delivery.acknowledged) {
      return unacknowledgedIntakeResult(
        watch,
        mode,
        changedCategories,
        deltas,
        refresh as unknown as JsonValue,
        intakeId,
      );
    }
    if (delivery.notification) {
      publishNotificationEvent({
        id: delivery.notification.id,
        action: 'created',
        notification: delivery.notification,
        changedAt: delivery.notification.createdAt,
      });
    }
    return {
      ok: true,
      changed: true,
      watchId: watch.id,
      repoId: watch.repoId,
      repoFullName: watch.repoFullName,
      prNumber: watch.prNumber,
      mode,
      changedCategories,
      deltas,
      message: `Durably recorded PR event ${intakeId} in notify-only mode.`,
      refresh: refresh as unknown as JsonValue,
    };
  }
  const notifications: AutomationExecutionResult['notifications'] = [
    eventNotification,
  ];
  let triage: JsonValue | undefined;
  let durableAdmissionId: string | undefined;

  const triageAttempts: JsonValue[] = [];
  if (pendingTriageEvents.length > 0) {
    if (!shouldRetainPendingTriage(currentWatermarks, deltas)) {
      triageAttempts.push(
        ...supersededPendingTriageSnapshots(pendingTriageEvents, deltas),
      );
    } else if (mode === 'notify-only') {
      triageAttempts.push(...pendingTriageSnapshots(pendingTriageEvents));
    } else {
      const retry = await admitWatchTriageEvents(
        watch,
        paths,
        dependencies,
        pendingTriageEvents.map((event) => event.input),
      );
      notifications.push(...retry.notifications);
      triageAttempts.push(...retry.triage);
      if (!retry.ok) {
        return {
          ok: false,
          changed: true,
          watchId: watch.id,
          repoId: watch.repoId,
          repoFullName: watch.repoFullName,
          prNumber: watch.prNumber,
          mode,
          changedCategories,
          deltas,
          message: retry.message ?? 'Autopilot triage admission failed.',
          refresh: refresh as unknown as JsonValue,
          triage: triageValue(triageAttempts),
          notifications,
        };
      }
    }
  }

  if (
    mode !== 'notify-only' &&
    deltas.length > 0 &&
    shouldAdmitTriageForDeltas(deltas)
  ) {
    const input = jsonRecord({
      repoId: watch.repoId,
      repoFullName: watch.repoFullName,
      prNumber: watch.prNumber,
      watchId: watch.id,
      eventId:
        intakeId ??
        prEventSourceId(watch, changedCategories, currentWatermarks),
      eventGenerationId: watch.eventGenerationId,
      source: 'watch',
      autopilotMode: triageModeForPolicy(mode),
      previous,
      current,
      deltas,
    });
    const admission = await admitWatchTriageEvent(
      watch,
      paths,
      dependencies,
      input,
    );
    notifications.push(...admission.notifications);
    if (admission.triage) triageAttempts.push(admission.triage);
    if (!admission.durablyAdmitted) {
      return {
        ok: false,
        changed: false,
        watchId: watch.id,
        repoId: watch.repoId,
        repoFullName: watch.repoFullName,
        prNumber: watch.prNumber,
        mode,
        changedCategories,
        deltas,
        message:
          admission.message ??
          'Autopilot triage did not produce a durable outcome; the PR event intake remains pending.',
        refresh: refresh as unknown as JsonValue,
        triage: triageValue(triageAttempts),
        notifications: admission.notifications,
      };
    }
    if (!admission.ok) {
      return {
        ok: false,
        changed: true,
        watchId: watch.id,
        repoId: watch.repoId,
        repoFullName: watch.repoFullName,
        prNumber: watch.prNumber,
        mode,
        changedCategories,
        deltas,
        message: admission.message ?? 'Autopilot triage admission failed.',
        refresh: refresh as unknown as JsonValue,
        triage: triageValue(triageAttempts),
        notifications,
      };
    }
    durableAdmissionId = admission.admissionId;
  }
  triage = triageValue(triageAttempts);

  if (intakeId) {
    const outcome = durableAdmissionId ? 'admission' : 'no-op';
    const acknowledgement = await acknowledgeWatchEventIntake(
      watch,
      intakeId,
      outcome,
      paths,
      dependencies,
      { admissionId: durableAdmissionId },
    );
    if (!acknowledgement.acknowledged) {
      return unacknowledgedIntakeResult(
        watch,
        mode,
        changedCategories,
        deltas,
        refresh as unknown as JsonValue,
        intakeId,
      );
    }
  }

  return {
    ok: true,
    changed: true,
    watchId: watch.id,
    repoId: watch.repoId,
    repoFullName: watch.repoFullName,
    prNumber: watch.prNumber,
    mode,
    changedCategories,
    deltas,
    message: refresh.message,
    refresh: refresh as unknown as JsonValue,
    triage,
    notifications,
  };
}

function isTerminalPrWithSettledChecks(snapshot: Record<string, unknown>) {
  const facts = jsonRecord(snapshot);
  return (
    stringField(facts.state) === 'closed' &&
    // A missing check watermark means no configured checks were observed. A
    // known pending result keeps the durable owner/watch alive for the next
    // poll instead of beginning terminal archival and worktree cleanup.
    stringField(facts.checkStatus) !== 'pending'
  );
}

async function processInitialWatchEventState(
  watch: PrWatch,
  currentWatermarks: PrWatchEventWatermarkRecord[],
  changedCategories: PrWatchEventWatermarkCategory[],
  mode: AutopilotMode,
  policy: Awaited<ReturnType<typeof readEffectiveWatchAutopilotPolicy>>,
  paths: RuntimePaths,
  dependencies: SchedulerDependencies,
  refresh: JsonValue,
  intakeId: string | undefined,
): Promise<WatchJobEventResult> {
  if (watch.initialEventProcessedAt) {
    return {
      ok: true,
      changed: false,
      watchId: watch.id,
      repoId: watch.repoId,
      repoFullName: watch.repoFullName,
      prNumber: watch.prNumber,
      mode,
      changedCategories,
      message: `Seeded PR event watermark baseline for ${watch.id}.`,
      refresh,
    };
  }

  if (!watch.processExisting) {
    return {
      ok: false,
      changed: false,
      watchId: watch.id,
      repoId: watch.repoId,
      repoFullName: watch.repoFullName,
      prNumber: watch.prNumber,
      mode,
      changedCategories,
      message:
        'The process-existing baseline is missing; reconfigure this watch before polling to avoid losing or replaying feedback.',
      refresh,
    };
  }

  const addressed = readAddressedPrFeedback(
    watch.repoFullName,
    watch.prNumber,
    paths,
  );
  let deliveries: ReturnType<typeof readNeondeckPrDeliveries>;
  try {
    deliveries = readNeondeckPrDeliveries(
      watch.repoFullName,
      watch.prNumber,
      paths,
    );
  } catch (error) {
    return invalidDeliveryLedgerResult(
      watch,
      changedCategories,
      mode,
      refresh,
      error,
    );
  }
  const filters = {
    addressedReviewThreadFingerprints: addressed.reviewThreadFingerprints,
    addressedReviewCommentFingerprints: addressed.reviewCommentFingerprints,
    neondeckReviewCommentFingerprints: deliveries.reviewCommentFingerprints,
    neondeckRequestedChangesReviewFingerprints: deliveries.reviewFingerprints,
    neondeckConversationCommentFingerprints:
      deliveries.conversationCommentFingerprints,
  };
  const deltas = initialActionableDeltas(currentWatermarks, filters);
  if (deltas.some((delta) => delta.type === 'incomplete-feedback')) {
    return {
      ok: false,
      changed: false,
      watchId: watch.id,
      repoId: watch.repoId,
      repoFullName: watch.repoFullName,
      prNumber: watch.prNumber,
      mode,
      changedCategories,
      deltas,
      message:
        'Current PR feedback is incomplete; initial processing remains pending until a complete authoritative fetch succeeds.',
      refresh,
    };
  }
  if (deltas.length === 0) {
    if (!intakeId) {
      return unacknowledgedIntakeResult(
        watch,
        mode,
        changedCategories,
        deltas,
        refresh,
        'missing',
      );
    }
    const acknowledgement = await acknowledgeWatchEventIntake(
      watch,
      intakeId,
      'no-op',
      paths,
      dependencies,
      { markInitialProcessed: true },
    );
    if (!acknowledgement.acknowledged) {
      return unacknowledgedIntakeResult(
        watch,
        mode,
        changedCategories,
        deltas,
        refresh,
        intakeId,
      );
    }
    return {
      ok: true,
      changed: false,
      watchId: watch.id,
      repoId: watch.repoId,
      repoFullName: watch.repoFullName,
      prNumber: watch.prNumber,
      mode,
      changedCategories,
      deltas,
      message: `Processed the initial PR state for ${watch.id}; no actionable current feedback was found.`,
      refresh,
    };
  }

  if (!('concurrency' in policy)) {
    return {
      ok: false,
      changed: true,
      watchId: watch.id,
      repoId: watch.repoId,
      repoFullName: watch.repoFullName,
      prNumber: watch.prNumber,
      mode,
      changedCategories,
      deltas,
      message:
        'Current PR feedback could not be durably admitted because Autopilot policy is unavailable.',
      refresh,
    };
  }

  if (mode === 'notify-only') {
    const notification = {
      ...prEventNotification(
        watch,
        initialActionableCategories,
        currentWatermarks,
        deltas,
        mode,
      ),
      ...(intakeId ? { sourceId: intakeId } : {}),
    };
    if (!intakeId) {
      return unacknowledgedIntakeResult(
        watch,
        mode,
        changedCategories,
        deltas,
        refresh,
        'missing',
      );
    }
    const delivery = await acknowledgeWatchEventIntake(
      watch,
      intakeId,
      'notification',
      paths,
      dependencies,
      { markInitialProcessed: true, notification },
    );
    if (!delivery.acknowledged) {
      return unacknowledgedIntakeResult(
        watch,
        mode,
        changedCategories,
        deltas,
        refresh,
        intakeId,
      );
    }
    if (delivery.notification) {
      publishNotificationEvent({
        id: delivery.notification.id,
        action: 'created',
        notification: delivery.notification,
        changedAt: delivery.notification.createdAt,
      });
    }
    return {
      ok: true,
      changed: true,
      watchId: watch.id,
      repoId: watch.repoId,
      repoFullName: watch.repoFullName,
      prNumber: watch.prNumber,
      mode,
      changedCategories,
      deltas,
      message: `Recorded current PR feedback for ${watch.id} in notify-only mode.`,
      refresh,
    };
  }

  const current = snapshotFromWatermarks(currentWatermarks);
  const eventId =
    intakeId ??
    prEventSourceId(watch, initialActionableCategories, currentWatermarks);
  const input = jsonRecord({
    repoId: watch.repoId,
    repoFullName: watch.repoFullName,
    prNumber: watch.prNumber,
    watchId: watch.id,
    eventId,
    eventGenerationId: watch.eventGenerationId,
    source: 'watch',
    synthetic: 'initial-actionable-state',
    autopilotMode: triageModeForPolicy(mode),
    previous: {},
    current,
    deltas,
  });
  const admission = await admitWatchTriageEvent(
    watch,
    paths,
    dependencies,
    input,
  );
  if (!admission.durablyAdmitted || !intakeId) {
    return {
      ok: false,
      changed: false,
      watchId: watch.id,
      repoId: watch.repoId,
      repoFullName: watch.repoFullName,
      prNumber: watch.prNumber,
      mode,
      changedCategories,
      deltas,
      message:
        admission.message ??
        'Current PR feedback did not reach a durable intake outcome and remains pending.',
      refresh,
      triage: admission.triage,
      notifications: admission.notifications,
    };
  }
  if (admission.durablyAdmitted && intakeId) {
    const acknowledgement = await acknowledgeWatchEventIntake(
      watch,
      intakeId,
      'admission',
      paths,
      dependencies,
      {
        markInitialProcessed: true,
        admissionId: admission.admissionId,
      },
    );
    if (!acknowledgement.acknowledged) {
      return unacknowledgedIntakeResult(
        watch,
        mode,
        changedCategories,
        deltas,
        refresh,
        intakeId,
      );
    }
  }
  return {
    ok: admission.ok,
    changed: true,
    watchId: watch.id,
    repoId: watch.repoId,
    repoFullName: watch.repoFullName,
    prNumber: watch.prNumber,
    mode,
    changedCategories,
    deltas,
    message: admission.durablyAdmitted
      ? `Durably admitted current actionable PR feedback for ${watch.id}.`
      : (admission.message ??
        `Current actionable PR feedback for ${watch.id} remains unprocessed.`),
    refresh,
    triage: admission.triage,
    notifications: [
      {
        ...prEventNotification(
          watch,
          changedCategories,
          currentWatermarks,
          deltas,
          mode,
        ),
        sourceId: intakeId,
      },
      ...admission.notifications,
    ],
  };
}

async function acknowledgeWatchEventIntake(
  watch: PrWatch,
  eventId: string,
  outcome: 'admission' | 'notification' | 'no-op',
  paths: RuntimePaths,
  dependencies: SchedulerDependencies,
  options: {
    markInitialProcessed?: boolean;
    admissionId?: string;
    notification?: NonNullable<
      AutomationExecutionResult['notifications']
    >[number];
  } = {},
) {
  await dependencies.beforePrWatchEventIntakeAcknowledged?.({
    watchId: watch.id,
    eventId,
    outcome,
  });
  return acknowledgePrWatchEventIntake(paths, {
    watchId: watch.id,
    eventId,
    outcome,
    markInitialProcessed: options.markInitialProcessed,
    admissionId: options.admissionId,
    notification: options.notification,
  });
}

function unacknowledgedIntakeResult(
  watch: PrWatch,
  mode: AutopilotMode,
  changedCategories: PrWatchEventWatermarkCategory[],
  deltas: JsonValue[],
  refresh: JsonValue,
  intakeId: string,
): WatchJobEventResult {
  return {
    ok: false,
    changed: false,
    watchId: watch.id,
    repoId: watch.repoId,
    repoFullName: watch.repoFullName,
    prNumber: watch.prNumber,
    mode,
    changedCategories,
    deltas,
    message: `PR event intake ${intakeId} was not acknowledged; it remains pending for restart-safe retry.`,
    refresh,
  };
}

function invalidDeliveryLedgerResult(
  watch: PrWatch,
  changedCategories: PrWatchEventWatermarkCategory[],
  mode: AutopilotMode,
  refresh: JsonValue,
  error: unknown,
): WatchJobEventResult {
  return {
    ok: false,
    changed: false,
    watchId: watch.id,
    repoId: watch.repoId,
    repoFullName: watch.repoFullName,
    prNumber: watch.prNumber,
    mode,
    changedCategories,
    message:
      'Stored Neondeck PR delivery identity is invalid and requires operator repair before this intake can be acknowledged.',
    refresh,
    triage: {
      status: 'blocked',
      reason: 'invalid-delivery-ledger',
      error: errorMessage(error),
    },
  };
}

function preservedPendingWatchTriage(
  watch: PrWatch,
  pendingEvents: PendingWatchTriageEvent[],
  refresh: JsonValue,
  mode: AutopilotMode,
): WatchJobEventResult {
  return {
    ok: true,
    changed: false,
    watchId: watch.id,
    repoId: watch.repoId,
    repoFullName: watch.repoFullName,
    prNumber: watch.prNumber,
    mode,
    message: `Preserved ${pendingEvents.length} pending autopilot triage event${pendingEvents.length === 1 ? '' : 's'} for ${watch.id}.`,
    refresh,
    triage: pendingTriageSnapshots(pendingEvents),
  };
}

async function retryPendingWatchTriage(
  watch: PrWatch,
  pendingEvents: PendingWatchTriageEvent[],
  paths: RuntimePaths,
  dependencies: SchedulerDependencies,
  refresh: JsonValue,
  mode: AutopilotMode,
): Promise<WatchJobEventResult> {
  const retry = await admitWatchTriageEvents(
    watch,
    paths,
    dependencies,
    pendingEvents.map((event) => event.input),
  );
  if (!retry.ok) {
    return {
      ok: false,
      changed: true,
      watchId: watch.id,
      repoId: watch.repoId,
      repoFullName: watch.repoFullName,
      prNumber: watch.prNumber,
      mode,
      message: retry.message ?? 'Autopilot triage admission failed.',
      refresh,
      triage: triageValue(retry.triage),
      notifications: retry.notifications,
    };
  }

  return {
    ok: true,
    changed: retry.triage.length > 0,
    watchId: watch.id,
    repoId: watch.repoId,
    repoFullName: watch.repoFullName,
    prNumber: watch.prNumber,
    mode,
    message:
      retry.triage.length > 0
        ? `Retried ${retry.triage.length} pending autopilot triage event${retry.triage.length === 1 ? '' : 's'} for ${watch.id}.`
        : `No PR event watermark changes for ${watch.id}.`,
    refresh,
    triage: triageValue(retry.triage),
    notifications: retry.notifications,
  };
}

async function admitWatchTriageEvents(
  watch: PrWatch,
  paths: RuntimePaths,
  dependencies: SchedulerDependencies,
  inputs: Array<Record<string, JsonValue>>,
) {
  const notifications: NonNullable<AutomationExecutionResult['notifications']> =
    [];
  const triage: JsonValue[] = [];
  let ok = true;
  let message: string | undefined;

  for (const input of inputs) {
    const admission = await admitWatchTriageEvent(
      watch,
      paths,
      dependencies,
      input,
    );
    notifications.push(...admission.notifications);
    if (admission.triage) triage.push(admission.triage);
    if (!admission.ok) {
      ok = false;
      message = admission.message ?? message;
    }
  }

  return { ok, triage, notifications, message };
}

async function admitWatchTriageEvent(
  watch: PrWatch,
  paths: RuntimePaths,
  dependencies: SchedulerDependencies,
  input: Record<string, JsonValue>,
): Promise<TriageAdmissionResult> {
  const eventId = stringField(input.eventId) ?? 'unknown';
  const eventGenerationId = stringField(input.eventGenerationId);
  if (!eventGenerationId) {
    return lostIntakeLeaseAdmissionResult(
      eventId,
      input,
      'The persisted watch event is missing its event-generation fence.',
    );
  }
  const policy = await readEffectiveWatchAutopilotPolicy(watch, paths);
  if (!('concurrency' in policy)) {
    return {
      ok: true,
      changed: true,
      triage: {
        status: 'blocked',
        eventId,
        reason: 'Autopilot policy is unavailable for this repository.',
        input,
      } as unknown as JsonValue,
      notifications: [
        {
          level: 'attention',
          title: 'Autopilot triage blocked',
          message: 'Autopilot policy is unavailable for this repository.',
          source: 'autopilot',
          sourceId: `triage:${watch.id}:${eventId}:blocked`,
          data: {
            watchId: watch.id,
            repoId: watch.repoId,
            repoFullName: watch.repoFullName,
            prNumber: watch.prNumber,
            eventId,
            input,
          },
        },
      ],
    };
  }
  let admission: Awaited<ReturnType<typeof claimAutopilotTriageAdmission>>;
  try {
    admission = await claimAutopilotTriageAdmission(
      {
        watchId: watch.id,
        eventFingerprint: eventId,
        repoId: watch.repoId,
        prNumber: watch.prNumber,
        mode: policy.mode,
        input,
        limits: policy.concurrency,
        requiredPendingIntake: { eventId, eventGenerationId },
      },
      paths,
    );
  } catch (error) {
    if (error instanceof AutopilotPendingIntakeLeaseLostError) {
      return lostIntakeLeaseAdmissionResult(eventId, input, error.message);
    }
    throw error;
  }
  if (!admission.claimed) {
    return {
      ok: true,
      changed: admission.reason !== 'duplicate',
      triage: {
        status: admission.admission.state,
        eventId,
        input,
        admission: admission.admission,
      } as unknown as JsonValue,
      notifications: [],
      durablyAdmitted: true,
      admissionId: admission.admission.id,
    };
  }

  const invokeWorkflow = dependencies.invokeWorkflow ?? invokeScheduledWorkflow;
  try {
    const coordination = await coordinateAutopilotAdmission(
      {
        admissionId: admission.admission.id,
        limits: policy.concurrency,
        invokeWorkflow: autopilotWorkflowInvoker(invokeWorkflow),
        enableOwnerDispatch: true,
      },
      paths,
    );
    const result = triageAdmissionResultFromCoordination({
      watch,
      eventId,
      input,
      admissionId: admission.admission.id,
      coordination,
    });
    return { ...result, admissionId: admission.admission.id };
  } catch (error) {
    const message = `Autopilot triage admission failed: ${errorMessage(error)}.`;
    return {
      ok: false,
      changed: true,
      message,
      triage: {
        status: 'failed',
        eventId,
        input,
        error: errorMessage(error),
      } as unknown as JsonValue,
      notifications: [
        {
          level: 'attention',
          title: 'Autopilot triage failed',
          message,
          source: 'autopilot',
          sourceId: `triage:${watch.id}:${eventId}:failed`,
          data: {
            watchId: watch.id,
            repoId: watch.repoId,
            repoFullName: watch.repoFullName,
            prNumber: watch.prNumber,
            eventId,
            input,
            error: errorMessage(error),
          },
        },
      ],
      durablyAdmitted: true,
      admissionId: admission.admission.id,
    };
  }
}

function lostIntakeLeaseAdmissionResult(
  eventId: string,
  input: Record<string, JsonValue>,
  message: string,
): TriageAdmissionResult {
  return {
    ok: false,
    changed: false,
    message,
    triage: {
      status: 'superseded',
      eventId,
      reason: 'pr-watch-event-intake-lease-lost',
      input,
    } as unknown as JsonValue,
    notifications: [],
    durablyAdmitted: false,
  };
}

export function triageAdmissionResultFromCoordination(input: {
  watch: Pick<PrWatch, 'id' | 'repoId' | 'repoFullName' | 'prNumber'>;
  eventId: string;
  input: Record<string, JsonValue>;
  admissionId: string;
  coordination: CoordinateAutopilotAdmissionResult;
}): TriageAdmissionResult {
  const triageInput = { ...input.input, admissionId: input.admissionId };
  const dispatched = input.coordination.dispatched;
  if (!dispatched) {
    return {
      ok: true,
      changed: true,
      triage: {
        status: 'deferred',
        eventId: input.eventId,
        workflow: 'triage-pr-event',
        input: triageInput,
      } as unknown as JsonValue,
      notifications: [],
      durablyAdmitted: true,
    };
  }

  if (dispatched.status === 'running') {
    return {
      ok: true,
      changed: true,
      triage: {
        status: 'admitted',
        eventId: input.eventId,
        runId:
          'runId' in dispatched
            ? dispatched.runId
            : 'dispatchId' in dispatched
              ? dispatched.dispatchId
              : null,
        workflow: 'triage-pr-event',
        input: triageInput,
      } as unknown as JsonValue,
      notifications: [],
      durablyAdmitted: true,
    };
  }

  const evidence = dispatchEvidence(dispatched, input.admissionId);
  if (
    dispatched.status === 'cas-lost' ||
    dispatched.status === 'stale-reservation' ||
    dispatched.status === 'not-reserved' ||
    dispatched.status === 'settled'
  ) {
    return {
      ok: true,
      changed: true,
      triage: {
        status: dispatched.status,
        eventId: input.eventId,
        workflow: 'triage-pr-event',
        input: triageInput,
        dispatch: evidence,
      } as unknown as JsonValue,
      notifications: [],
      durablyAdmitted: true,
    };
  }

  const error =
    dispatched.status === 'dispatch-failed'
      ? dispatched.error
      : dispatchFailureMessage(dispatched.status);
  const message = `Autopilot triage admission failed: ${error}.`;
  return {
    ok: false,
    changed: true,
    message,
    triage: {
      status:
        dispatched.status === 'dispatch-failed' ? 'failed' : dispatched.status,
      eventId: input.eventId,
      workflow: 'triage-pr-event',
      input: triageInput,
      dispatch: evidence,
      error,
    } as unknown as JsonValue,
    notifications: [
      {
        level: 'attention',
        title: 'Autopilot triage failed',
        message,
        source: 'autopilot',
        sourceId: `triage:${input.watch.id}:${input.eventId}:${dispatched.status}`,
        data: {
          watchId: input.watch.id,
          repoId: input.watch.repoId,
          repoFullName: input.watch.repoFullName,
          prNumber: input.watch.prNumber,
          eventId: input.eventId,
          input: triageInput,
          dispatch: evidence,
          error,
        },
      },
    ],
    durablyAdmitted: true,
  };
}

function dispatchEvidence(
  dispatched: NonNullable<CoordinateAutopilotAdmissionResult['dispatched']>,
  admissionId: string,
) {
  if (dispatched.status === 'missing') {
    return { status: dispatched.status, admissionId };
  }
  if (dispatched.status === 'settled') {
    return {
      status: dispatched.status,
      admissionId: dispatched.admission?.id ?? admissionId,
      queuedAdmissionId: dispatched.queuedAdmissionId,
    };
  }

  return {
    status: dispatched.status,
    admissionId: dispatched.admission.id,
    admissionState: dispatched.admission.state,
    admissionVersion: dispatched.admission.version,
    attemptId: dispatched.attempt.id,
    attemptStatus: dispatched.attempt.status,
    attemptNumber: dispatched.attempt.attemptNumber,
    workflow: dispatched.attempt.workflow,
    ...(dispatched.status === 'dispatch-failed'
      ? { error: dispatched.error }
      : {}),
    ...('runId' in dispatched ? { runId: dispatched.runId } : {}),
  };
}

function dispatchFailureMessage(
  status: 'missing' | 'orphaned-receipt' | 'unsupported-transport' | 'blocked',
) {
  if (status === 'blocked') {
    return 'owner grounding blocked the dispatch before any model turn was accepted';
  }
  if (status === 'orphaned-receipt') {
    return 'Flue accepted a workflow receipt that could not be attached to its durable admission';
  }
  if (status === 'unsupported-transport') {
    return 'the reserved autopilot stage cannot be dispatched by the configured workflow transport';
  }
  return 'the durable autopilot admission or stage attempt could not be found';
}

export function pendingEventResultsFromJobResult(value: JsonValue | null) {
  return readJsonArray(readObjectConfig(value).eventResults).filter(
    (eventResult) => pendingTriageEventsFromEventResult(eventResult).length > 0,
  );
}

function autopilotWorkflowInvoker(
  invokeWorkflow: NonNullable<SchedulerDependencies['invokeWorkflow']>,
): AutopilotWorkflowInvoker {
  return (workflow, input) => {
    return invokeWorkflow(workflow, input);
  };
}

function pendingTriageEventsFromJobResult(value: JsonValue | null) {
  const pendingByWatch = new Map<string, PendingWatchTriageEvent[]>();
  const eventResults = readJsonArray(readObjectConfig(value).eventResults);
  for (const eventResult of eventResults) {
    for (const triageEvent of pendingTriageEventsFromEventResult(eventResult)) {
      const pending = pendingByWatch.get(triageEvent.watchId) ?? [];
      if (!pending.some((item) => item.eventId === triageEvent.eventId)) {
        pending.push({
          eventId: triageEvent.eventId,
          input: triageEvent.input,
          reason: triageEvent.reason,
        });
      }
      pendingByWatch.set(triageEvent.watchId, pending);
    }
  }

  return pendingByWatch;
}

function pendingTriageEventsFromEventResult(value: unknown) {
  const result = readObjectConfig(value);
  const watchId = stringField(result.watchId);
  if (!watchId) return [];

  return triageRecords(result.triage)
    .map((triage) => pendingTriageEventFromRecord(watchId, triage))
    .filter((event): event is PendingWatchTriageEvent & { watchId: string } =>
      Boolean(event),
    );
}

function pendingTriageEventFromRecord(
  watchId: string,
  triage: Record<string, unknown>,
) {
  const status = stringField(triage.status);
  if (status !== 'blocked' && status !== 'failed') return null;

  const input = readJsonRecord(triage.input);
  if (!input) return null;

  return {
    watchId,
    eventId: stringField(input.eventId) ?? `${watchId}:pending`,
    input,
    reason: status,
  };
}

function triageRecords(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.flatMap((item) => triageRecords(item));
  }

  const record = readObjectConfig(value);
  const nested = readObjectConfig(record.triage);
  return Object.keys(nested).length > 0 ? [nested] : [record];
}

function pendingTriageSnapshots(events: PendingWatchTriageEvent[]) {
  return events.map((event) =>
    jsonRecord({
      status: event.reason === 'failed' ? 'failed' : 'blocked',
      eventId: event.eventId,
      reason: event.reason,
      input: event.input,
    }),
  );
}

function supersededPendingTriageSnapshots(
  events: PendingWatchTriageEvent[],
  deltas: Array<Record<string, unknown>>,
) {
  return events.map((event) =>
    jsonRecord({
      status: 'superseded',
      eventId: event.eventId,
      reason: 'current-pr-state-non-actionable',
      input: event.input,
      supersededBy: deltas as unknown as JsonValue,
    }),
  );
}

function triageValue(attempts: JsonValue[]) {
  if (attempts.length === 0) return undefined;
  return attempts.length === 1 ? attempts[0] : (attempts as JsonValue);
}

async function readEffectiveWatchAutopilotPolicy(
  watch: PrWatch,
  paths: RuntimePaths,
) {
  const [registry, appConfig] = await Promise.all([
    readRepoRegistrySnapshot(paths),
    readRuntimeJson(paths.config, parseAppConfig),
  ]);
  const repo = registry.repos.find(
    (candidate) => candidate.id === watch.repoId,
  );
  if (!repo) {
    return { mode: 'notify-only' as AutopilotMode };
  }

  return repoAutopilotPolicyForWatch(repo, appConfig, {
    id: watch.id,
    prNumber: watch.prNumber,
  });
}

function watchIdFromResult(result: unknown) {
  const watch = readObjectConfig(
    result && typeof result === 'object' && !Array.isArray(result)
      ? (result as { watch?: unknown }).watch
      : undefined,
  );
  const id = watch.id;
  return typeof id === 'string' ? id : undefined;
}

function changedCategoriesFromActionResult(result: unknown) {
  const data = dataFromActionResult(result);
  const categories = Array.isArray(data.changedCategories)
    ? data.changedCategories
    : [];
  return categories.filter(isWatermarkCategory);
}

function watermarksFromActionResult(result: unknown) {
  const data = dataFromActionResult(result);
  const watermarks = Array.isArray(data.watermarks) ? data.watermarks : [];
  return watermarks
    .map(readWatermarkLike)
    .filter((item): item is PrWatchEventWatermarkRecord => Boolean(item));
}

function previousWatermarksFromActionResult(result: unknown) {
  const data = dataFromActionResult(result);
  if (!Array.isArray(data.previousWatermarks)) return undefined;
  return data.previousWatermarks
    .map(readWatermarkLike)
    .filter((item): item is PrWatchEventWatermarkRecord => Boolean(item));
}

function intakeIdFromActionResult(result: unknown) {
  const intakeId = dataFromActionResult(result).intakeId;
  return typeof intakeId === 'string' && intakeId.length > 0
    ? intakeId
    : undefined;
}

function seededUpgradeFromActionResult(result: unknown) {
  return dataFromActionResult(result).seededUpgrade === true;
}

function dataFromActionResult(result: unknown) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return {};
  return readObjectConfig((result as { data?: unknown }).data);
}

function readWatermarkLike(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const category = record.category;
  if (!isWatermarkCategory(category)) return null;
  return {
    watchId: typeof record.watchId === 'string' ? record.watchId : '',
    category,
    watermark: (record.watermark ?? null) as JsonValue,
    sourceUpdatedAt:
      typeof record.sourceUpdatedAt === 'string'
        ? record.sourceUpdatedAt
        : null,
    checkedAt: typeof record.checkedAt === 'string' ? record.checkedAt : '',
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
  };
}

function isWatermarkCategory(
  value: unknown,
): value is PrWatchEventWatermarkCategory {
  return (
    value === 'commits' ||
    value === 'review_threads' ||
    value === 'requested_changes_reviews' ||
    value === 'conversation_comments' ||
    value === 'check_suites' ||
    value === 'check_runs' ||
    value === 'mergeability' ||
    value === 'out_of_date_branch'
  );
}

function triageModeForPolicy(mode: AutopilotMode) {
  return mode;
}
