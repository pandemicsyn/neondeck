import type { JsonValue } from '@flue/runtime';
import {
  type JobRecord,
  type NotificationLevel,
} from '../../app-state';
import { fetchCheckSummary, type GitHubCheckSummary } from '../../github';
import { readRepoRegistrySnapshot, repoFullName } from '../../repos';
import type { RuntimePaths } from '../../runtime-home';
import { listPrWatchRecords, listRefWatchRecords, refreshPrWatch, refreshRefWatch } from '../watches';
import type {
  BlueprintKind,
  JobExecutionResult,
  SchedulerDependencies,
  ScheduledWorkflowName,
} from './schemas';
import { errorMessage, failResult } from './utils';

export async function executeJob(
  job: JobRecord,
  paths: RuntimePaths,
  dependencies: SchedulerDependencies,
): Promise<JobExecutionResult> {
  if (job.type === 'watch-pr') {
    return refreshWatchJob(job, paths, dependencies.refreshPrWatch);
  }

  if (job.type === 'watch-ref') {
    return refreshRefWatchJob(job, paths, dependencies.refreshRefWatch);
  }

  if (job.type === 'morning-briefing') {
    const invokeWorkflow =
      dependencies.invokeWorkflow ?? invokeScheduledWorkflow;
    const { runId } = await invokeWorkflow('briefing', {});

    return {
      outcome: 'recorded',
      message: `Admitted morning briefing workflow ${runId}.`,
      result: { runId },
      notifications: [
        {
          level: 'info',
          title: 'Morning briefing queued',
          message: 'A morning briefing workflow was queued for Neon.',
          source: 'scheduler',
          sourceId: job.id,
          data: { runId },
        },
      ],
    };
  }

  if (job.type === 'review-queue-digest') {
    const invokeWorkflow =
      dependencies.invokeWorkflow ?? invokeScheduledWorkflow;
    const { runId } = await invokeWorkflow('command-run', {
      command: '/review-queue',
    });

    return {
      outcome: 'recorded',
      message: `Admitted review queue digest workflow ${runId}.`,
      result: { runId },
      notifications: [
        {
          level: 'info',
          title: 'Review queue digest due',
          message: 'A review queue digest workflow was queued.',
          source: 'scheduler',
          sourceId: job.id,
          data: { runId },
        },
      ],
    };
  }

  if (job.type === 'release-watch') {
    return refreshReleaseWatchJob(job, paths, dependencies.fetchCheckSummary);
  }

  return {
    outcome: 'silent',
    message: `No executor is registered for job type "${job.type}".`,
  };
}

export async function invokeScheduledWorkflow(
  workflow: ScheduledWorkflowName,
  input: JsonValue,
) {
  const { invoke } = await import('@flue/runtime');

  if (workflow === 'briefing') {
    const module = await import('../../workflows/briefing');
    return invoke(module.default, { input: input as Record<string, never> });
  }

  const module = await import('../../workflows/command-run');
  return invoke(module.default, {
    input: input as { command: string },
  });
}

export async function refreshReleaseWatchJob(
  job: JobRecord,
  paths: RuntimePaths,
  fetchChecks: typeof fetchCheckSummary = fetchCheckSummary,
): Promise<JobExecutionResult> {
  const registry = await readRepoRegistrySnapshot(paths);
  const config = readObjectConfig(job.config);
  const repoRef = typeof config.repo === 'string' ? config.repo : undefined;
  const sourceWatchId =
    typeof config.sourceWatchId === 'string' ? config.sourceWatchId : undefined;
  let sourceWatch:
    Awaited<ReturnType<typeof listPrWatchRecords>>[number] | undefined;
  const repo = repoRef
    ? registry.repos.find(
        (item) =>
          item.id === repoRef ||
          item.github.name === repoRef ||
          repoFullName(item).toLowerCase() === repoRef.toLowerCase(),
      )
    : undefined;

  if (!repo) {
    return {
      outcome: 'failed',
      message: repoRef
        ? `Release watch repository "${repoRef}" is not configured.`
        : 'Release watch requires a configured repository.',
      notifications: [
        {
          level: 'attention',
          title: 'Release watch failed',
          message: repoRef
            ? `Repository "${repoRef}" is not configured.`
            : 'Release watch requires a repository.',
          source: 'release-watch',
          sourceId: job.id,
          data: job.config,
        },
      ],
    };
  }

  if (sourceWatchId) {
    sourceWatch = (await listPrWatchRecords(paths)).find(
      (watch) => watch.id === sourceWatchId,
    );
    if (!sourceWatch) {
      return {
        outcome: 'failed',
        message: `Linked PR watch "${sourceWatchId}" does not exist.`,
        notifications: [
          {
            level: 'attention',
            title: 'Release watch failed',
            message: `Linked PR watch "${sourceWatchId}" does not exist.`,
            source: 'release-watch',
            sourceId: job.id,
            data: job.config,
          },
        ],
      };
    }
    if (!['merged', 'green'].includes(sourceWatch.status)) {
      return {
        outcome: 'silent',
        message: `Release watch is waiting for PR watch "${sourceWatchId}" to merge.`,
        result: {
          repo: repo.id,
          sourceWatchId,
          sourceWatchStatus: sourceWatch.status,
        },
      };
    }
    if (!sourceWatch.mergeCommitSha) {
      return {
        outcome: 'failed',
        message: `Linked PR watch "${sourceWatchId}" has no merge commit SHA.`,
        notifications: [
          {
            level: 'attention',
            title: 'Release watch failed',
            message: `Linked PR watch "${sourceWatchId}" has no merge commit SHA.`,
            source: 'release-watch',
            sourceId: job.id,
            data: job.config,
          },
        ],
      };
    }
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return {
      outcome: 'failed',
      message: 'GITHUB_TOKEN is not configured.',
      notifications: [
        {
          level: 'attention',
          title: 'Release watch failed',
          message: 'GITHUB_TOKEN is not configured.',
          source: 'release-watch',
          sourceId: job.id,
          data: { repo: repo.id, requires: ['GITHUB_TOKEN'] },
        },
      ],
    };
  }

  try {
    const ref = sourceWatch?.mergeCommitSha ?? repo.defaultBranch;
    const checks = await fetchChecks({
      token,
      owner: repo.github.owner,
      repo: repo.github.name,
      ref,
    });
    const snapshot = {
      repo: repo.id,
      repoFullName: repoFullName(repo),
      defaultBranch: repo.defaultBranch,
      ref,
      sourceWatchId: sourceWatch?.id ?? null,
      sourceMergeCommitSha: sourceWatch?.mergeCommitSha ?? null,
      productionTarget: repo.productionTarget ?? null,
      checks,
      checkedAt: new Date().toISOString(),
    };
    const previous = readReleaseWatchResult(job.lastResult);
    const statusChanged = previous?.checks.status !== checks.status;
    const shouldNotify =
      statusChanged &&
      (checks.status === 'success' || checks.status === 'failure');

    return {
      outcome: statusChanged ? 'updated' : 'silent',
      message: statusChanged
        ? `Release watch ${repo.id} ${ref} is ${checks.status}.`
        : `Release watch ${repo.id} ${ref} is unchanged.`,
      result: snapshot,
      notifications: shouldNotify
        ? [releaseWatchNotification(job, snapshot)]
        : undefined,
    };
  } catch (error) {
    return {
      outcome: 'failed',
      message: `Could not fetch release watch checks: ${errorMessage(error)}.`,
      notifications: [
        {
          level: 'attention',
          title: 'Release watch failed',
          message: `Could not fetch checks for ${repoFullName(repo)}@${sourceWatch?.mergeCommitSha ?? repo.defaultBranch}.`,
          source: 'release-watch',
          sourceId: job.id,
          data: { error: errorMessage(error), repo: repo.id },
        },
      ],
    };
  }
}

export function releaseWatchNotification(
  job: JobRecord,
  snapshot: {
    repo: string;
    repoFullName: string;
    defaultBranch: string;
    ref: string;
    sourceWatchId: string | null;
    sourceMergeCommitSha: string | null;
    productionTarget: string | null;
    checks: GitHubCheckSummary;
    checkedAt: string;
  },
) {
  const failed = snapshot.checks.status === 'failure';
  const titleTarget = snapshot.sourceMergeCommitSha
    ? 'merge commit'
    : snapshot.defaultBranch;
  return {
    level: failed ? ('urgent' as const) : ('ready' as const),
    title: failed
      ? 'Release watch needs attention'
      : `Release watch ${titleTarget} green`,
    message: failed
      ? `${snapshot.repoFullName}@${snapshot.ref} checks failed.`
      : `${snapshot.repoFullName}@${snapshot.ref} checks are green.`,
    source: 'release-watch',
    sourceId: job.id,
    data: snapshot,
  };
}

export function readReleaseWatchResult(value: JsonValue | null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const checks = (value as { checks?: unknown }).checks;
  if (!checks || typeof checks !== 'object' || Array.isArray(checks)) {
    return undefined;
  }
  const status = (checks as { status?: unknown }).status;
  return typeof status === 'string'
    ? { checks: { status } as GitHubCheckSummary }
    : undefined;
}

export async function refreshWatchJob(
  job: JobRecord,
  paths: RuntimePaths,
  refreshWatch: SchedulerDependencies['refreshPrWatch'] = refreshPrWatch,
): Promise<JobExecutionResult> {
  const config = readObjectConfig(job.config);
  const target =
    typeof config.id === 'string'
      ? { id: config.id }
      : typeof config.ref === 'string'
        ? { ref: config.ref }
        : undefined;

  const results = [];
  if (target) {
    results.push(await refreshWatch(target, paths));
  } else {
    const watches = await listPrWatchRecords(paths);
    for (const watch of watches) {
      results.push(await refreshWatch({ id: watch.id }, paths));
    }
  }

  const failures = results.filter((result) => !result.ok);
  if (failures.length > 0) {
    return {
      outcome: 'failed',
      message: `Failed to refresh ${failures.length} PR watch${failures.length === 1 ? '' : 'es'}.`,
      result: { results },
      notifications: failures.map((result) => ({
        level: 'attention',
        title: 'PR watch refresh failed',
        message: result.message,
        source: 'watch-pr',
        sourceId: failedWatchSourceId(result, target),
        data: result,
      })),
    };
  }

  const changed = results.filter((result) => result.changed);
  const notifications = changed.map((result) => {
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
      sourceId: watch?.id,
      data: result.watch,
    };
  });

  return {
    outcome: changed.length > 0 ? 'updated' : 'silent',
    message:
      changed.length > 0
        ? `Updated ${changed.length} PR watch${changed.length === 1 ? '' : 'es'}.`
        : 'PR watch refresh had no changes.',
    result: { results },
    notifications,
  };
}

export async function refreshRefWatchJob(
  job: JobRecord,
  paths: RuntimePaths,
  refreshWatch: SchedulerDependencies['refreshRefWatch'] = refreshRefWatch,
): Promise<JobExecutionResult> {
  const config = readObjectConfig(job.config);
  const target =
    typeof config.id === 'string'
      ? { id: config.id }
      : typeof config.repo === 'string' && typeof config.ref === 'string'
        ? { repo: config.repo, ref: config.ref }
        : typeof config.target === 'string'
          ? { target: config.target }
          : undefined;

  const results = [];
  if (target) {
    results.push(await refreshWatch(target, paths));
  } else {
    const watches = await listRefWatchRecords(paths);
    for (const watch of watches) {
      results.push(await refreshWatch({ id: watch.id }, paths));
    }
  }

  const failures = results.filter((result) => !result.ok);
  if (failures.length > 0) {
    return {
      outcome: 'failed',
      message: `Failed to refresh ${failures.length} ref watch${failures.length === 1 ? '' : 'es'}.`,
      result: { results },
      notifications: failures.map((result) => ({
        level: 'attention',
        title: 'Ref watch refresh failed',
        message: result.message,
        source: 'watch-ref',
        sourceId: failedWatchSourceId(result, target),
        data: result,
      })),
    };
  }

  const changed = results.filter((result) => result.changed);
  const notifications = changed.map((result) => {
    const watch = result.watch as { id?: string; status?: string } | undefined;
    const level: NotificationLevel =
      watch?.status === 'attention-needed'
        ? 'attention'
        : watch?.status === 'green'
          ? 'ready'
          : 'info';
    const title =
      watch?.status === 'green'
        ? 'Ref watch green'
        : watch?.status === 'attention-needed'
          ? 'Ref watch needs attention'
          : 'Ref watch changed';

    return {
      level,
      title,
      message: result.message,
      source: 'watch-ref',
      sourceId: watch?.id,
      data: result.watch,
    };
  });

  return {
    outcome: changed.length > 0 ? 'updated' : 'silent',
    message:
      changed.length > 0
        ? `Updated ${changed.length} ref watch${changed.length === 1 ? '' : 'es'}.`
        : 'Ref watch refresh had no changes.',
    result: { results },
    notifications,
  };
}

export function failedWatchSourceId(
  result: unknown,
  target: { id?: string; ref?: string } | undefined,
) {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const watch = (result as { watch?: unknown }).watch;
    if (watch && typeof watch === 'object' && !Array.isArray(watch)) {
      const id = (watch as { id?: unknown }).id;
      if (typeof id === 'string') return id;
    }
  }

  return target?.id ?? target?.ref ?? 'all-watches';
}

export function readIntervalSeconds(config: unknown, type: BlueprintKind | string) {
  const record = readObjectConfig(config);
  const value = record.intervalSeconds;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 60) {
    return value;
  }

  return defaultIntervalSeconds(type);
}

export function defaultIntervalSeconds(type: BlueprintKind | string) {
  if (type === 'watch-pr') return 300;
  if (type === 'release-watch') return 900;
  if (type === 'review-queue-digest') return 3_600;
  return 86_400;
}

export function defaultBlueprintId(blueprint: BlueprintKind, target?: string) {
  const suffix = target
    ? target
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
    : 'default';
  return `${blueprint}-${suffix}`;
}

export async function resolveReleaseWatchRepo(repoRef: string, paths: RuntimePaths) {
  const registry = await readRepoRegistrySnapshot(paths);
  const matches = registry.repos.filter(
    (repo) =>
      repo.id === repoRef ||
      repo.github.name === repoRef ||
      repoFullName(repo).toLowerCase() === repoRef.toLowerCase(),
  );

  if (matches.length === 1) {
    return { ok: true as const, repo: matches[0] };
  }

  if (matches.length > 1) {
    return {
      ok: false as const,
      result: failResult(
        'schedule_blueprint_create',
        `Repository "${repoRef}" is ambiguous.`,
        { requires: ['repo'] },
      ),
    };
  }

  return {
    ok: false as const,
    result: failResult(
      'schedule_blueprint_create',
      `Repository "${repoRef}" is not configured.`,
      { requires: ['repo'] },
    ),
  };
}

export function readObjectConfig(config: unknown) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {};
  return config as Record<string, unknown>;
}
