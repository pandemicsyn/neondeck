import { runExecFile } from '../../lib/exec';
import { renderReportHtml } from '../../lib/report-html';
import type { JobRecord } from '../app-state';
import { listPreparedDiffs } from '../prepared-diffs';
import { writeReport } from '../reports';
import { readRepoRegistrySnapshot, repoFullName } from '../repos';
import type { JobExecutionResult } from '../scheduler';
import { listPrWatchRecords } from '../watches';
import { listWorktrees } from '../worktrees';
import type { RuntimePaths } from '../../runtime-home';

type HygieneItem = {
  kind: string;
  label: string;
  detail: string;
};

export async function runHygieneJob(
  job: JobRecord,
  paths: RuntimePaths,
): Promise<JobExecutionResult> {
  const config = objectConfig(job.config);
  const staleBranchDays = numberConfig(config.staleBranchDays, 30);
  const stalledDecisionHours = numberConfig(config.stalledDecisionHours, 48);
  const registry = await readRepoRegistrySnapshot(paths);
  const repoRef = stringConfig(config.repo);
  const repos = repoRef
    ? registry.repos.filter(
        (repo) =>
          repo.id === repoRef ||
          repo.github.name === repoRef ||
          repoFullName(repo).toLowerCase() === repoRef.toLowerCase(),
      )
    : registry.repos;
  if (repoRef && repos.length === 0) {
    return failed(job, `Hygiene repository "${repoRef}" is not configured.`);
  }

  const [branchItems, worktreeItems, decisionItems, watchItems] =
    await Promise.all([
      staleBranchItems(repos, staleBranchDays),
      worktreeCleanupItems(paths),
      stalledPreparedDiffItems(paths, stalledDecisionHours),
      staleWatchItems(paths),
    ]);
  const items = [
    ...branchItems,
    ...worktreeItems,
    ...decisionItems,
    ...watchItems,
  ];
  const result = {
    repoCount: repos.length,
    itemCount: items.length,
    counts: countKinds(items),
    checkedAt: new Date().toISOString(),
  };

  if (items.length === 0) {
    return {
      outcome: 'silent',
      message: 'Hygiene found no actionable items.',
      result,
    };
  }

  const report = await writeReport(
    {
      kind: 'hygiene',
      title: 'Workspace hygiene',
      sourceRef: repoRef ?? 'all-repos',
      createdBy: `scheduler:${job.id}`,
      summary: result,
      html: renderReportHtml({
        title: 'Workspace hygiene',
        eyebrow: 'HYGIENE',
        summary: `${items.length} local hygiene item${items.length === 1 ? '' : 's'} need review.`,
        sections: [
          {
            title: 'Summary',
            items: Object.entries(result.counts).map(([kind, count]) => ({
              label: kind,
              value: String(count),
            })),
          },
          {
            title: 'Items',
            items: items.slice(0, 80).map((item) => ({
              label: item.label,
              value: `${item.kind}\n${item.detail}`,
            })),
          },
        ],
      }),
    },
    paths,
  );

  return {
    outcome: 'updated',
    message: `Hygiene found ${items.length} item${items.length === 1 ? '' : 's'}.`,
    result: { ...result, reportId: report.id },
    notifications: [
      {
        level: 'info',
        title: 'Hygiene report ready',
        message: `${items.length} local hygiene item${items.length === 1 ? '' : 's'} need review.`,
        source: 'hygiene',
        sourceId: job.id,
        data: {
          reportId: report.id,
          reportUrl: `/reports/${report.id}`,
          counts: result.counts,
        },
      },
    ],
  };
}

export async function readHygieneSummary(paths: RuntimePaths) {
  const [worktrees, preparedDiffs, watches] = await Promise.all([
    listWorktrees(paths),
    listPreparedDiffs({}, paths),
    listPrWatchRecords(paths),
  ]);
  return {
    worktreeCleanupCandidates: worktrees.worktrees.filter((worktree) =>
      ['cleanup-pending', 'failed', 'needs-sync'].includes(
        worktree.lifecycleStatus,
      ),
    ).length,
    stalledPreparedDiffs: (preparedDiffs.preparedDiffs ?? []).filter((diff) =>
      ['prepared', 'revision-requested', 'push-approved'].includes(diff.status),
    ).length,
    closedOrMergedWatches: watches.filter((watch) =>
      ['closed', 'merged'].includes(watch.status),
    ).length,
  };
}

async function staleBranchItems(
  repos: Array<{
    id: string;
    path: string;
    defaultBranch: string;
    github: { owner: string; name: string };
  }>,
  staleAfterDays: number,
) {
  const cutoff = Date.now() - staleAfterDays * 24 * 60 * 60 * 1000;
  const items: HygieneItem[] = [];
  for (const repo of repos) {
    const merged = new Set(
      await gitLines(repo.path, [
        'branch',
        '--format=%(refname:short)',
        '--merged',
        repo.defaultBranch,
      ]).catch(() => []),
    );
    const branches = await gitLines(repo.path, [
      'for-each-ref',
      '--format=%(refname:short)|%(committerdate:iso8601)',
      'refs/heads',
    ]).catch(() => []);
    for (const branch of branches) {
      const [name, dateText] = branch.split('|');
      if (!name || name === repo.defaultBranch) continue;
      const updatedAt = Date.parse(dateText ?? '');
      if (!merged.has(name) && updatedAt >= cutoff) continue;
      items.push({
        kind: 'stale-branch',
        label: `${repoFullName(repo)}:${name}`,
        detail: `Last commit: ${dateText || 'unknown'}\nMerged into ${repo.defaultBranch}: ${merged.has(name) ? 'yes' : 'no'}\nSuggested command: git branch -d ${name}`,
      });
    }
  }
  return items.slice(0, 80);
}

async function worktreeCleanupItems(paths: RuntimePaths) {
  const snapshot = await listWorktrees(paths);
  return snapshot.worktrees
    .filter((worktree) =>
      ['cleanup-pending', 'failed', 'needs-sync'].includes(
        worktree.lifecycleStatus,
      ),
    )
    .map((worktree) => ({
      kind: 'worktree-cleanup',
      label: worktree.id,
      detail: `${worktree.repoFullName} ${worktree.headRef}\nstatus: ${worktree.lifecycleStatus}\npath: ${worktree.localPath}`,
    }));
}

async function stalledPreparedDiffItems(
  paths: RuntimePaths,
  stalledAfterHours: number,
) {
  const cutoff = Date.now() - stalledAfterHours * 60 * 60 * 1000;
  const snapshot = await listPreparedDiffs({}, paths);
  return (snapshot.preparedDiffs ?? [])
    .filter(
      (diff) =>
        ['prepared', 'revision-requested', 'push-approved'].includes(
          diff.status,
        ) && Date.parse(diff.updatedAt) < cutoff,
    )
    .map((diff) => ({
      kind: 'stalled-decision',
      label: diff.id,
      detail: `${diff.repoFullName}${diff.prNumber ? `#${diff.prNumber}` : ''}\nstatus: ${diff.status}\nupdated: ${diff.updatedAt}`,
    }));
}

async function staleWatchItems(paths: RuntimePaths) {
  const watches = await listPrWatchRecords(paths);
  return watches
    .filter((watch) => ['closed', 'merged'].includes(watch.status))
    .map((watch) => ({
      kind: 'stale-watch',
      label: watch.id,
      detail: `${watch.repoFullName}#${watch.prNumber}\nstatus: ${watch.status}\nlast checked: ${watch.lastCheckedAt ?? 'unknown'}`,
    }));
}

function countKinds(items: HygieneItem[]) {
  return items.reduce<Record<string, number>>((counts, item) => {
    counts[item.kind] = (counts[item.kind] ?? 0) + 1;
    return counts;
  }, {});
}

async function gitLines(cwd: string, args: string[]) {
  const { stdout } = await runExecFile('git', args, { cwd });
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function stringConfig(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberConfig(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function objectConfig(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function failed(job: JobRecord, message: string): JobExecutionResult {
  return {
    outcome: 'failed',
    message,
    notifications: [
      {
        level: 'attention',
        title: 'Hygiene failed',
        message,
        source: 'hygiene',
        sourceId: job.id,
      },
    ],
  };
}
