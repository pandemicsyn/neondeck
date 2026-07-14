import type { JsonValue } from '@flue/runtime';
import type { NotificationLevel } from '../app-state';
import type { RuntimePaths } from '../../runtime-home';
import { refreshPrWatch } from '../watches';
import type { SchedulerDependencies } from './schemas';
import {
  pendingEventResultsFromJobResult,
  refreshWatchJobEvents,
} from './pr-watch-events';

export { invokeScheduledWorkflow } from './workflow-invocation';

export async function refreshWatchTask(
  watchId: string,
  previousResult: JsonValue | null,
  paths: RuntimePaths,
  dependencies: SchedulerDependencies = {},
) {
  const refreshWatch = dependencies.refreshPrWatch ?? refreshPrWatch;
  const result = await refreshWatch({ id: watchId }, paths);
  if (!result.ok) {
    const pendingEventResults =
      pendingEventResultsFromJobResult(previousResult);
    return {
      outcome: 'failed' as const,
      message: `Failed to refresh PR watch "${watchId}".`,
      result: {
        results: [result],
        ...(pendingEventResults.length > 0
          ? { eventResults: pendingEventResults }
          : {}),
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
    result: {
      results: [result],
      ...(eventResults.length > 0 ? { eventResults } : {}),
    },
    notifications,
  };
}

function notificationFromWatchResult(
  result: Awaited<ReturnType<typeof refreshPrWatch>>,
  watchId: string,
) {
  const watch = result.watch as WatchNotificationFacts | undefined;
  const level: NotificationLevel =
    watch?.status === 'closed' || watch?.status === 'attention-needed'
      ? 'attention'
      : watch?.status === 'merged' || watch?.status === 'green'
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

type WatchNotificationFacts = {
  id?: string;
  repoFullName?: string;
  prNumber?: number;
  status?: string;
  prState?: string | null;
  lastSnapshot?: {
    merged?: boolean;
    checks?: {
      status?: string;
      total?: number;
      failed?: number;
      pending?: number;
    } | null;
  } | null;
};

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
      typeof failed === 'number' && failed > 0
        ? typeof total === 'number' && total > 0
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
        typeof total === 'number' && total > 0
          ? `${subject}: all ${total} ${total === 1 ? 'check' : 'checks'} passed.`
          : `${subject}: all checks passed.`,
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
