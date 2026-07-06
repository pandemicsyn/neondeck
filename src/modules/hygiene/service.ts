import { openDb } from '../../lib/sqlite';
import { runBoundedGit, runBoundedGitLines } from '../../lib/git';
import { renderReportHtml } from '../../lib/report-html';
import type { JobExecutionResult, JobRecord } from '../app-state';
import { loadMemoryBackgroundContextSync } from '../memory';
import { listPreparedDiffs } from '../prepared-diffs';
import { writeReport } from '../reports';
import { readRepoRegistrySnapshot, repoFullName } from '../repos';
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
  try {
    return await runHygieneJobInner(job, paths);
  } catch (error) {
    return failed(job, `Hygiene failed: ${errorMessage(error)}.`);
  }
}

async function runHygieneJobInner(
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

  const [
    branchItems,
    worktreeItems,
    decisionItems,
    approvalItems,
    watchItems,
    todoItems,
  ] = await Promise.all([
    staleBranchItems(repos, staleBranchDays),
    worktreeCleanupItems(paths),
    stalledPreparedDiffItems(paths, stalledDecisionHours),
    unusedExecutionApprovalItems(paths),
    staleWatchItems(paths),
    todoAgingItems(repos),
  ]);
  const items = [
    ...branchItems,
    ...worktreeItems,
    ...decisionItems,
    ...approvalItems,
    ...watchItems,
    ...todoItems,
  ];
  const memoryContext = loadMemoryBackgroundContextSync(paths, {
    repoId: repos.length === 1 ? (repos[0]?.id ?? null) : null,
  });
  const result = {
    repoCount: repos.length,
    itemCount: items.length,
    counts: countKinds(items),
    memoryIds: memoryContext.memoryIds,
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
          memoryReportSection(memoryContext),
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

function memoryReportSection(
  context: ReturnType<typeof loadMemoryBackgroundContextSync>,
) {
  return {
    title: 'Memory Context',
    items: [
      {
        label: 'structured memory',
        value: context.text,
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
  const unusedApprovals = countUnusedExecutionApprovals(paths);
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
    unusedExecutionApprovals: unusedApprovals,
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

function unusedExecutionApprovalItems(paths: RuntimePaths) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const rows = database
      .prepare(
        `
        SELECT id, command, backend, cwd, created_at, resolved_at, updated_at
        FROM execution_approvals
        WHERE status = 'approved'
          AND used_at IS NULL
        ORDER BY updated_at ASC
        LIMIT 40;
      `,
      )
      .all() as Array<{
      id: string;
      command: string;
      backend: string;
      cwd: string | null;
      created_at: string;
      resolved_at: string | null;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      kind: 'unused-execution-approval',
      label: row.id,
      detail: `${row.backend}: ${row.command}\ncwd: ${row.cwd ?? 'default'}\napproved: ${row.resolved_at ?? row.updated_at}\ncreated: ${row.created_at}`,
    }));
  } finally {
    database.close();
  }
}

function countUnusedExecutionApprovals(paths: RuntimePaths) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM execution_approvals
        WHERE status = 'approved'
          AND used_at IS NULL;
      `,
      )
      .get() as { count?: number } | undefined;
    return typeof row?.count === 'number' ? row.count : 0;
  } finally {
    database.close();
  }
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

async function todoAgingItems(
  repos: Array<{
    id: string;
    path: string;
    defaultBranch: string;
    github: { owner: string; name: string };
  }>,
) {
  const items: HygieneItem[] = [];
  for (const repo of repos) {
    const lines = await gitLines(repo.path, [
      'grep',
      '-n',
      '-I',
      '-E',
      'TODO|FIXME|HACK',
      '--',
      '.',
    ]).catch(() => []);
    if (lines.length === 0) continue;

    const paths = [...new Set(lines.map(todoPath).filter(Boolean))].slice(
      0,
      30,
    ) as string[];
    let oldest: { path: string; date: string } | null = null;
    for (const path of paths) {
      const date = await git(repo.path, [
        'log',
        '-1',
        '--format=%cI',
        '--',
        path,
      ]).catch(() => '');
      if (!date) continue;
      if (!oldest || Date.parse(date) < Date.parse(oldest.date)) {
        oldest = { path, date };
      }
    }

    items.push({
      kind: 'todo-aging',
      label: `${repoFullName(repo)} TODO/FIXME/HACK`,
      detail: [
        `${lines.length} tracked marker${lines.length === 1 ? '' : 's'} found.`,
        oldest ? `Oldest touched file: ${oldest.path} (${oldest.date})` : null,
        'Examples:',
        ...lines.slice(0, 5),
      ]
        .filter(Boolean)
        .join('\n'),
    });
  }
  return items;
}

function todoPath(line: string) {
  const separator = line.indexOf(':');
  return separator > 0 ? line.slice(0, separator) : null;
}

function countKinds(items: HygieneItem[]) {
  return items.reduce<Record<string, number>>((counts, item) => {
    counts[item.kind] = (counts[item.kind] ?? 0) + 1;
    return counts;
  }, {});
}

async function gitLines(cwd: string, args: string[]) {
  return runBoundedGitLines(cwd, args);
}

async function git(cwd: string, args: string[]) {
  return runBoundedGit(cwd, args);
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
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
