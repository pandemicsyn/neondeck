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
    const pendingEventResults = pendingEventResultsFromJobResult(previousResult);
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
  const watch = result.watch as { id?: string; status?: string } | undefined;
  const level: NotificationLevel =
    watch?.status === 'closed' || watch?.status === 'attention-needed'
      ? 'attention'
      : watch?.status === 'merged' || watch?.status === 'green'
        ? 'ready'
        : 'info';
  const title =
    watch?.status === 'green'
      ? 'PR watch green'
      : watch?.status === 'attention-needed'
        ? 'PR watch needs attention'
        : watch?.status === 'merged'
          ? 'PR watch merged'
          : watch?.status === 'closed'
            ? 'PR watch closed'
            : 'PR watch changed';
  return {
    level,
    title,
    message: result.message,
    source: 'watch-pr',
    sourceId: watch?.id ?? watchId,
    data: result.watch,
  };
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
