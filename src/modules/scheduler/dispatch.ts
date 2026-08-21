import type { JsonValue } from '@flue/runtime';
import type { NotificationLevel } from '../app-state';
import type { RuntimePaths } from '../../runtime-home';
import { refreshPrWatch } from '../watches';
import { completeAutopilotWatchIfTerminal } from '../autopilot';
import type { SchedulerDependencies } from './schemas';
import { refreshWatchJobEvents } from './pr-watch-events';
import * as v from 'valibot';

const watchNotificationFactsSchema = v.object({
  id: v.optional(v.string()),
  repoFullName: v.optional(v.string()),
  prNumber: v.optional(v.number()),
  status: v.optional(v.string()),
  prState: v.optional(v.nullable(v.string())),
  lastSnapshot: v.optional(
    v.nullable(
      v.object({
        merged: v.optional(v.boolean()),
        reviewDecision: v.optional(v.nullable(v.string())),
        checks: v.optional(
          v.nullable(
            v.object({
              status: v.optional(v.string()),
              total: v.optional(v.number()),
              failed: v.optional(v.number()),
              pending: v.optional(v.number()),
            }),
          ),
        ),
      }),
    ),
  ),
});
type WatchNotificationFacts = v.InferOutput<
  typeof watchNotificationFactsSchema
>;
type WatchRefreshResultData = {
  results: Awaited<ReturnType<typeof refreshPrWatch>>[];
  eventResults?: Awaited<ReturnType<typeof refreshWatchJobEvents>>;
};

export async function refreshWatchTask(
  watchId: string,
  previousResult: JsonValue | null,
  paths: RuntimePaths,
  dependencies: SchedulerDependencies = {},
) {
  const refreshWatch = dependencies.refreshPrWatch ?? refreshPrWatch;
  const result = await refreshWatch({ id: watchId }, paths);
  if (!result.ok) {
    return {
      outcome: 'failed' as const,
      message: `Failed to refresh PR watch "${watchId}".`,
      result: {
        results: [result],
      },
      notifications: [
        {
          level: 'attention' as const,
          title: 'PR watch refresh failed',
          message: result.message,
          source: 'watch-pr',
          sourceId: watchId,
          data: result,
        },
      ],
    };
  }

  const terminal = await completeAutopilotWatchIfTerminal(watchId, paths);
  if (terminal.complete) {
    return {
      outcome: 'updated' as const,
      message: `Completed PR watch "${watchId}" after terminal checks settled.`,
      result: { results: [result], terminal },
      notifications: result.changed
        ? [notificationFromWatchResult(result, watchId)]
        : [],
      persistedNotifications: [],
    };
  }

  const eventResults = await refreshWatchJobEvents(
    [result],
    paths,
    dependencies,
    previousResult,
  );
  const eventFailures = eventResults.filter((item) => !item.ok);
  const eventChanges = eventResults.filter((item) => item.ok && item.changed);
  const notifications = [
    ...(result.changed ? [notificationFromWatchResult(result, watchId)] : []),
    ...eventResults.flatMap((item) => item.notifications ?? []),
  ];
  const persistedNotifications = eventResults.flatMap(
    (item) => item.persistedNotifications ?? [],
  );
  const resultData: WatchRefreshResultData = { results: [result] };
  if (eventResults.length > 0) resultData.eventResults = eventResults;
  return {
    outcome:
      eventFailures.length > 0
        ? ('failed' as const)
        : result.changed || eventChanges.length > 0
          ? ('updated' as const)
          : ('silent' as const),
    message: watchRefreshMessage(
      result.changed ? 1 : 0,
      eventChanges.length,
      eventFailures.length,
    ),
    result: resultData,
    notifications,
    persistedNotifications,
  };
}

function notificationFromWatchResult(
  result: Awaited<ReturnType<typeof refreshPrWatch>>,
  watchId: string,
) {
  const parsedWatch = v.safeParse(watchNotificationFactsSchema, result.watch);
  const watch = parsedWatch.success ? parsedWatch.output : undefined;
  const level: NotificationLevel =
    watch?.status === 'closed' || watch?.status === 'attention-needed'
      ? 'attention'
      : watch?.status === 'merged' ||
          watch?.status === 'green' ||
          watch?.status === 'ready'
        ? 'ready'
        : 'info';
  const copy = watchNotificationCopy(watch, result.message);
  return {
    level,
    title: copy.title,
    message: copy.message,
    source: 'watch-pr',
    sourceId: watch?.id ?? watchId,
    data: result.watch,
  };
}

export function watchNotificationCopy(
  watch: WatchNotificationFacts | undefined,
  fallbackMessage: string,
) {
  const titleSubject = watch?.prNumber ? `PR ${watch.prNumber}` : 'PR watch';
  const subject =
    watch?.id ??
    (watch?.repoFullName && watch.prNumber
      ? `${watch.repoFullName}#${watch.prNumber}`
      : 'PR watch');
  const checks = watch?.lastSnapshot?.checks;

  if (watch?.status === 'attention-needed') {
    const failed = checks?.failed;
    const total = checks?.total;
    const failedLabel =
      failed !== undefined && failed > 0
        ? total !== undefined && total > 0
          ? `${failed} of ${total} ${total === 1 ? 'check' : 'checks'} failed`
          : `${failed} ${failed === 1 ? 'check' : 'checks'} failed`
        : 'checks are failing';
    const state = watch.lastSnapshot?.merged
      ? ' is merged, but '
      : watch.prState === 'closed'
        ? ' is closed, but '
        : ' has ';
    return {
      title: `${titleSubject} needs attention`,
      message: `${subject}${state}${failedLabel}.`,
    };
  }

  if (watch?.status === 'green') {
    const total = checks?.total;
    return {
      title: `${titleSubject} checks passed`,
      message:
        total !== undefined && total > 0
          ? `${subject}: all ${total} ${total === 1 ? 'check' : 'checks'} passed.`
          : `${subject}: all checks passed.`,
    };
  }

  if (watch?.status === 'ready') {
    return {
      title: `${titleSubject} approved`,
      message: `${subject}: required reviews approved.`,
    };
  }

  if (watch?.status === 'merged') {
    return { title: `${titleSubject} merged`, message: `${subject} merged.` };
  }

  if (watch?.status === 'closed') {
    return {
      title: `${titleSubject} closed`,
      message: `${subject} closed without merging.`,
    };
  }

  return { title: 'PR watch changed', message: fallbackMessage };
}

function watchRefreshMessage(
  watchChanges: number,
  eventChanges: number,
  eventFailures: number,
) {
  if (eventFailures > 0) {
    return `Failed to refresh ${eventFailures} PR event watch${eventFailures === 1 ? '' : 'es'}.`;
  }
  if (watchChanges > 0 && eventChanges > 0) {
    return `Updated ${watchChanges} PR watch${watchChanges === 1 ? '' : 'es'} and ${eventChanges} PR event watch${eventChanges === 1 ? '' : 'es'}.`;
  }
  if (watchChanges > 0) {
    return `Updated ${watchChanges} PR watch${watchChanges === 1 ? '' : 'es'}.`;
  }
  if (eventChanges > 0) {
    return `Updated ${eventChanges} PR event watch${eventChanges === 1 ? '' : 'es'}.`;
  }
  return 'PR watch refresh had no changes.';
}
