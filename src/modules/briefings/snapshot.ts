import { asJsonValue } from '../../lib/action-result';
import type { RuntimePaths } from '../../runtime-home';
import { listNotifications } from '../app-state';
import { readAutopilotState } from '../autopilot';
import type { CommandDependencies } from '../commands/schemas';
import { readReviewQueue } from '../commands/handlers/queue';
import { readHygieneSummary } from '../hygiene';
import { readRepoRegistrySnapshot } from '../repos';
import { listScheduledTasks } from '../scheduled-tasks';
import { listPrWatchRecords } from '../watches';
import type { BriefingSnapshot, BriefingSnapshotSource } from './schemas';

const collectionLimit = 40;
const snapshotByteLimit = 96_000;

export type BriefingSnapshotDependencies = CommandDependencies & {
  readRepos?: typeof readRepoRegistrySnapshot;
  readWatches?: typeof listPrWatchRecords;
  readTasks?: typeof listScheduledTasks;
  readNotifications?: typeof listNotifications;
  readHygiene?: typeof readHygieneSummary;
  readAutopilot?: typeof readAutopilotState;
};

export async function collectBriefingSnapshot(
  paths: RuntimePaths,
  dependencies: BriefingSnapshotDependencies = {},
): Promise<BriefingSnapshot> {
  const collectedAt = new Date().toISOString();
  const [
    repos,
    reviewQueue,
    watches,
    tasks,
    notifications,
    hygiene,
    autopilot,
  ] = await Promise.all([
    capture('repos', async () => {
      const registry = await (
        dependencies.readRepos ?? readRepoRegistrySnapshot
      )(paths);
      return boundedList(
        registry.repos.map((repo) => ({
          id: repo.id,
          fullName: `${repo.github.owner}/${repo.github.name}`,
          localPath: repo.path,
        })),
      );
    }),
    capture('reviewQueue', async () => {
      const result = await readReviewQueue(paths, dependencies);
      if (!result.ok) {
        return {
          data: {
            available: false,
            message: result.message,
            requires: result.requires ?? [],
            errors: result.errors ?? [],
          },
          partial: true,
        };
      }
      const items = result.queue.items.map((item) => ({
        repo: item.repo,
        number: item.number,
        title: item.title,
        url: item.url,
        author: item.author,
        checks: item.checks,
        updatedAt: item.updatedAt,
      }));
      return {
        ...boundedList(items),
        data: {
          ...boundedList(items).data,
          issues: result.queue.issues.slice(0, 12),
          fetchedAt: result.queue.fetchedAt,
        },
        partial: result.queue.truncated || result.queue.issues.length > 0,
      };
    }),
    capture('watches', async () => {
      const records = await (dependencies.readWatches ?? listPrWatchRecords)(
        paths,
      );
      return boundedList(
        records.map((watch) => ({
          id: watch.id,
          repoId: watch.repoId,
          prNumber: watch.prNumber,
          title: watch.title,
          status: watch.status,
          url: watch.url,
          lastCheckedAt: watch.lastCheckedAt,
        })),
      );
    }),
    capture('scheduledTasks', async () => {
      const records = await (dependencies.readTasks ?? listScheduledTasks)(
        paths,
      );
      return boundedList(
        records.map((task) => ({
          id: task.id,
          kind: task.spec.kind,
          enabled: task.enabled,
          nextRunAt: task.nextRunAt,
          lastRunAt: task.lastRunAt,
        })),
      );
    }),
    capture('notifications', async () => {
      const records = await (
        dependencies.readNotifications ?? listNotifications
      )(paths);
      return boundedList(
        records
          .filter((notification) => !notification.readAt)
          .map((notification) => ({
            id: notification.id,
            level: notification.level,
            title: notification.title,
            message: notification.message,
            source: notification.source,
            createdAt: notification.createdAt,
          })),
      );
    }),
    capture('hygiene', async () => ({
      data: await (dependencies.readHygiene ?? readHygieneSummary)(paths),
    })),
    capture('autopilot', async () => {
      const state = await (dependencies.readAutopilot ?? readAutopilotState)(
        paths,
      );
      return {
        data: {
          summary: state.summary,
          preparedDiffs: state.preparedDiffs.slice(0, collectionLimit),
          pendingApprovals: state.pendingApprovals.slice(0, collectionLimit),
          runningChecks: state.runningChecks.slice(0, collectionLimit),
        },
        truncated:
          state.preparedDiffs.length > collectionLimit ||
          state.pendingApprovals.length > collectionLimit ||
          state.runningChecks.length > collectionLimit,
      };
    }),
  ]);

  const sources = {
    repos,
    reviewQueue,
    watches,
    scheduledTasks: tasks,
    notifications,
    hygiene,
    autopilot,
  };
  const initial = {
    version: 1 as const,
    collectedAt,
    byteSize: 0,
    truncated: Object.values(sources).some((source) => source.truncated),
    sources,
  };
  const sizedInitial = withByteSize(initial);
  if (sizedInitial.byteSize <= snapshotByteLimit) return sizedInitial;

  const compactSources = Object.fromEntries(
    Object.entries(sources).map(([name, source]) => [
      name,
      {
        ...source,
        status: source.status === 'unavailable' ? 'unavailable' : 'partial',
        truncated: true,
        ...(source.error ? { error: truncateText(source.error, 1_000) } : {}),
        data: asJsonValue(compactData(source.data)),
      },
    ]),
  ) as Record<string, BriefingSnapshotSource>;
  const compact = {
    version: 1 as const,
    collectedAt,
    byteSize: 0,
    truncated: true,
    sources: compactSources,
  };
  const sizedCompact = withByteSize(compact);
  if (sizedCompact.byteSize <= snapshotByteLimit) return sizedCompact;

  return withByteSize({
    ...compact,
    sources: Object.fromEntries(
      Object.entries(compactSources).map(([name, source]) => [
        name,
        {
          ...source,
          data: null,
          error: source.error ? truncateText(source.error, 300) : undefined,
        },
      ]),
    ),
  });
}

async function capture(
  _name: string,
  read: () => Promise<{
    data: unknown;
    truncated?: boolean;
    partial?: boolean;
  }>,
): Promise<BriefingSnapshotSource> {
  const fetchedAt = new Date().toISOString();
  try {
    const result = await read();
    return {
      status: result.partial || result.truncated ? 'partial' : 'ok',
      fetchedAt,
      truncated: Boolean(result.truncated),
      data: asJsonValue(result.data),
    };
  } catch (error) {
    return {
      status: 'unavailable',
      fetchedAt,
      truncated: false,
      error: truncateText(
        error instanceof Error ? error.message : String(error),
        1_000,
      ),
      data: null,
    };
  }
}

function withByteSize(snapshot: BriefingSnapshot): BriefingSnapshot {
  let candidate = snapshot;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const byteSize = Buffer.byteLength(JSON.stringify(candidate), 'utf8');
    if (byteSize === candidate.byteSize) return candidate;
    candidate = { ...candidate, byteSize };
  }
  return candidate;
}

function truncateText(value: string, limit: number) {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

function boundedList<T>(items: T[]) {
  return {
    data: {
      total: items.length,
      items: items.slice(0, collectionLimit),
    },
    truncated: items.length > collectionLimit,
  };
}

function compactData(data: unknown, depth = 0): unknown {
  if (typeof data === 'string') {
    return data.length > 300 ? `${data.slice(0, 297)}...` : data;
  }
  if (
    data === null ||
    typeof data === 'number' ||
    typeof data === 'boolean' ||
    data === undefined
  ) {
    return data ?? null;
  }
  if (depth >= 3) {
    return Array.isArray(data)
      ? { total: data.length, truncated: true }
      : { truncated: true };
  }
  if (Array.isArray(data)) {
    return data.slice(0, 3).map((value) => compactData(value, depth + 1));
  }
  if (typeof data !== 'object') return String(data);
  return Object.fromEntries(
    Object.entries(data)
      .slice(0, 3)
      .map(([key, value]) => [key, compactData(value, depth + 1)]),
  );
}
