import type { GitHubPullRequestQueue, GitHubPullRequest, GitHubQueueIssue } from '../../../github';
import { fetchGitHubLogin, fetchPullRequestQueue } from '../../../github';
import { readRepoRegistrySnapshot } from '../../../repos';
import { listPrWatchRecords } from '../../watches';
import type { RuntimePaths } from '../../../runtime-home';
import type { CommandDependencies, NeonCommandResult, ParsedNeonCommand, ReviewQueueAction } from '../schemas';
import { completedCommand, failedCommand, needsConfigCommand } from '../summaries';
import { errorMessage } from '../utils';

export async function reviewQueueCommand(
  command: ParsedNeonCommand,
  paths: RuntimePaths,
  dependencies: CommandDependencies,
): Promise<NeonCommandResult> {
  const queue = await readReviewQueue(paths, dependencies);
  if (!queue.ok) {
    return needsConfigCommand(command.name, command.raw, queue.message, {
      requires: queue.requires,
      errors: queue.errors,
    });
  }
  const watches = await listPrWatchRecords(paths);
  const triage = triageReviewQueue(queue.queue, watches);

  return completedCommand(
    command.name,
    command.raw,
    reviewQueueMessage(triage),
    {
      fetchedAt: queue.queue.fetchedAt,
      login: queue.queue.login,
      repos: queue.queue.repos,
      count: queue.queue.items.length,
      truncated: queue.queue.truncated,
      issues: queue.queue.issues,
      items: queue.queue.items,
      triage,
      topActions: triage.topActions,
    },
  );
}

export async function explainCiCommand(
  command: ParsedNeonCommand,
  paths: RuntimePaths,
  dependencies: CommandDependencies,
): Promise<NeonCommandResult> {
  const queue = await readReviewQueue(paths, dependencies);
  if (!queue.ok) {
    return needsConfigCommand(command.name, command.raw, queue.message, {
      requires: queue.requires,
      errors: queue.errors,
    });
  }

  const selected = selectPullRequest(queue.queue, command.args, {
    prefer: (item) =>
      item.checks?.status === 'failure' ||
      item.checkError !== undefined ||
      item.checks?.status === 'pending',
  });
  if (!selected.ok) {
    return failedCommand(command.name, command.raw, selected.message, {
      requires: selected.requires,
      data: {
        available: summarizePullRequests(queue.queue.items).slice(0, 10),
      },
    });
  }

  const pr = selected.item;
  const explanation = ciExplanation(pr);
  return completedCommand(command.name, command.raw, explanation.message, {
    pr: summarizePullRequests([pr])[0],
    checks: pr.checks,
    checkError: pr.checkError,
    explanation,
    assistantBrief:
      'Use these deterministic CI/check facts first. Separate observed facts from likely next debugging steps.',
  });
}

export async function summarizePrCommand(
  command: ParsedNeonCommand,
  paths: RuntimePaths,
  dependencies: CommandDependencies,
): Promise<NeonCommandResult> {
  const queue = await readReviewQueue(paths, dependencies);
  if (!queue.ok) {
    return needsConfigCommand(command.name, command.raw, queue.message, {
      requires: queue.requires,
      errors: queue.errors,
    });
  }

  const selected = selectPullRequest(queue.queue, command.args);
  if (!selected.ok) {
    return failedCommand(command.name, command.raw, selected.message, {
      requires: selected.requires,
      data: {
        available: summarizePullRequests(queue.queue.items).slice(0, 10),
      },
    });
  }

  const pr = selected.item;
  const summary = {
    headline: `${pr.repo}#${pr.number}: ${pr.title}`,
    state: pr.state,
    author: pr.author,
    relations: pr.relations,
    labels: pr.labels,
    comments: pr.comments,
    ageDays: pr.ageDays,
    stale: pr.stale,
    baseRef: pr.baseRef,
    headSha: pr.headSha,
    checks: pr.checks?.status ?? 'unknown',
    url: pr.url,
  };

  return completedCommand(
    command.name,
    command.raw,
    `Summarized ${pr.repo}#${pr.number}.`,
    {
      pr: summarizePullRequests([pr])[0],
      summary,
      assistantBrief:
        'Summarize the PR from these deterministic facts. Do not invent diff contents that were not fetched.',
    },
  );
}

export function triageReviewQueue(
  queue: GitHubPullRequestQueue,
  watches: Awaited<ReturnType<typeof listPrWatchRecords>>,
) {
  const authored = queue.items.filter((item) =>
    item.relations.includes('authored'),
  );
  const assigned = queue.items.filter((item) =>
    item.relations.includes('assigned'),
  );
  const requestedReviews = queue.items.filter((item) =>
    item.relations.includes('review-requested'),
  );
  const failedChecks = queue.items.filter(
    (item) => item.checks?.status === 'failure',
  );
  const checkErrors = queue.items.filter((item) => item.checkError);
  const stalePrs = queue.items.filter((item) => item.stale);
  const activeWatches = watches.filter((watch) =>
    ['watching', 'merged', 'attention-needed'].includes(watch.status),
  );
  const watchedPrs = queue.items.filter((item) =>
    activeWatches.some(
      (watch) =>
        watch.repoFullName === item.repo && watch.prNumber === item.number,
    ),
  );

  return {
    summary: {
      authored: authored.length,
      assigned: assigned.length,
      requestedReviews: requestedReviews.length,
      failedChecks: failedChecks.length,
      checkErrors: checkErrors.length,
      stale: stalePrs.length,
      activeWatches: activeWatches.length,
      watchedPrs: watchedPrs.length,
      truncated: queue.truncated,
      issues: queue.issues.length,
    },
    authored: summarizePullRequests(authored),
    assigned: summarizePullRequests(assigned),
    requestedReviews: summarizePullRequests(requestedReviews),
    failedChecks: summarizePullRequests(failedChecks),
    checkErrors: summarizePullRequests(checkErrors),
    stalePrs: summarizePullRequests(stalePrs),
    issues: summarizeQueueIssues(queue.issues),
    activeWatches: activeWatches.map((watch) => ({
      id: watch.id,
      repo: watch.repoFullName,
      number: watch.prNumber,
      status: watch.status,
      desiredTerminalState: watch.desiredTerminalState,
      url: watch.url,
      updatedAt: watch.updatedAt,
    })),
    topActions: rankReviewQueueActions(
      queue.items,
      activeWatches,
      failedChecks,
      checkErrors,
      requestedReviews,
      assigned,
      stalePrs,
      authored,
    ).slice(0, 3),
  };
}

export function summarizePullRequests(items: GitHubPullRequest[]) {
  return items.map((item) => ({
    repo: item.repo,
    number: item.number,
    title: item.title,
    url: item.url,
    author: item.author,
    relations: item.relations,
    checks: item.checks?.status ?? 'unknown',
    checkError: item.checkError,
    stale: item.stale,
    ageDays: item.ageDays,
    updatedAt: item.updatedAt,
  }));
}

export function summarizeQueueIssues(issues: GitHubQueueIssue[]) {
  return issues.map((issue) => ({
    type: issue.type,
    message: issue.message,
    query: issue.query,
    repo: issue.repo,
    number: issue.number,
  }));
}

export function rankReviewQueueActions(
  items: GitHubPullRequest[],
  watches: Awaited<ReturnType<typeof listPrWatchRecords>>,
  failedChecks: GitHubPullRequest[],
  checkErrors: GitHubPullRequest[],
  requestedReviews: GitHubPullRequest[],
  assigned: GitHubPullRequest[],
  stalePrs: GitHubPullRequest[],
  authored: GitHubPullRequest[],
): ReviewQueueAction[] {
  const actions: ReviewQueueAction[] = [];
  for (const item of failedChecks) {
    actions.push(prAction(item, 'Fix failing checks', 'urgent'));
  }

  for (const item of checkErrors) {
    actions.push(prAction(item, 'Investigate unknown CI status', 'urgent'));
  }

  for (const watch of watches.filter(
    (item) => item.status === 'attention-needed',
  )) {
    actions.push({
      title: `Resolve watch ${watch.id}`,
      reason: `Watch is ${watch.status}.`,
      priority: 'urgent',
      url: watch.url,
      repo: watch.repoFullName,
      number: watch.prNumber,
    });
  }

  for (const item of requestedReviews) {
    actions.push(prAction(item, 'Review requested PR', 'high'));
  }

  for (const item of assigned) {
    actions.push(prAction(item, 'Move assigned PR forward', 'high'));
  }

  for (const item of stalePrs) {
    actions.push(prAction(item, 'Refresh stale PR', 'medium'));
  }

  for (const item of authored) {
    actions.push(prAction(item, 'Advance authored PR', 'medium'));
  }

  for (const item of items) {
    actions.push(prAction(item, 'Inspect open PR', 'low'));
  }

  return dedupeActions(actions);
}

export function prAction(
  item: GitHubPullRequest,
  reason: string,
  priority: ReviewQueueAction['priority'],
): ReviewQueueAction {
  return {
    title: `${reason}: ${item.repo}#${item.number}`,
    reason:
      item.checks?.status === 'failure'
        ? `${item.checks.failed} checks failed.`
        : item.checkError
          ? `GitHub enrichment failed: ${item.checkError}`
          : reason,
    priority,
    url: item.url,
    repo: item.repo,
    number: item.number,
  };
}

export function dedupeActions(actions: ReviewQueueAction[]) {
  const seen = new Set<string>();
  return actions.filter((action) => {
    const key =
      action.repo && action.number
        ? `${action.repo}#${action.number}`
        : `${action.title}:${action.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function reviewQueueMessage(triage: ReturnType<typeof triageReviewQueue>) {
  const { summary } = triage;
  const partial = summary.truncated || summary.issues > 0;
  return `Triaged ${summary.authored + summary.assigned + summary.requestedReviews} user-related PR signal${summary.authored + summary.assigned + summary.requestedReviews === 1 ? '' : 's'}: ${summary.requestedReviews} review request${summary.requestedReviews === 1 ? '' : 's'}, ${summary.failedChecks} failing check set${summary.failedChecks === 1 ? '' : 's'}, ${summary.checkErrors} unknown check state${summary.checkErrors === 1 ? '' : 's'}, ${summary.stale} stale PR${summary.stale === 1 ? '' : 's'}.${partial ? ' Results are partial; inspect queue issues.' : ''}`;
}

export function selectPullRequest(
  queue: GitHubPullRequestQueue,
  args: string[],
  options: { prefer?: (item: GitHubPullRequest) => boolean } = {},
):
  | { ok: true; item: GitHubPullRequest }
  | { ok: false; message: string; requires?: string[] } {
  const ref = args.join(' ').trim();
  if (ref) {
    const parsed = parsePullRequestRef(ref);
    if (!parsed) {
      return {
        ok: false,
        message:
          'Expected a PR reference like repo#123, owner/repo#123, or a GitHub pull request URL.',
        requires: ['pr'],
      };
    }

    const match = queue.items.find(
      (item) =>
        item.number === parsed.number &&
        (item.repo.toLowerCase() === parsed.repo.toLowerCase() ||
          item.repo.split('/').at(1)?.toLowerCase() ===
            parsed.repo.toLowerCase()),
    );
    if (!match) {
      return {
        ok: false,
        message: `PR ${parsed.repo}#${parsed.number} was not found in the current review queue.`,
        requires: ['queuedPr'],
      };
    }

    return { ok: true, item: match };
  }

  const preferred = options.prefer
    ? queue.items.find(options.prefer)
    : undefined;
  const item = preferred ?? queue.items[0];
  if (!item) {
    return {
      ok: false,
      message: 'No pull requests are available in the current review queue.',
      requires: ['pr'],
    };
  }

  return { ok: true, item };
}

export function parsePullRequestRef(ref: string) {
  const url = ref.match(/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i);
  if (url) {
    return {
      repo: `${url[1]}/${url[2].replace(/\.git$/, '')}`,
      number: Number(url[3]),
    };
  }

  const hash = ref.match(/^([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?)#(\d+)$/);
  if (!hash) return undefined;

  return {
    repo: hash[1],
    number: Number(hash[2]),
  };
}

export function ciExplanation(pr: GitHubPullRequest) {
  if (pr.checkError) {
    return {
      status: 'unknown',
      message: `GitHub check status for ${pr.repo}#${pr.number} could not be enriched.`,
      facts: [`Enrichment error: ${pr.checkError}`],
      nextActions: [
        'Open the PR checks page in GitHub.',
        'Retry after confirming the token can read checks.',
      ],
    };
  }

  if (!pr.checks) {
    return {
      status: 'unknown',
      message: `${pr.repo}#${pr.number} has no check summary in the queue.`,
      facts: ['No check runs or commit statuses were available.'],
      nextActions: [
        'Confirm the PR head SHA and configured repository access.',
      ],
    };
  }

  const facts = [
    `${pr.checks.total} total check signal${pr.checks.total === 1 ? '' : 's'}.`,
    `${pr.checks.failed} failed, ${pr.checks.pending} pending, ${pr.checks.successful} successful.`,
    `${pr.checks.statusContexts ?? 0} legacy status context${pr.checks.statusContexts === 1 ? '' : 's'}.`,
  ];
  const nextActions =
    pr.checks.status === 'failure'
      ? [
          'Open the failing GitHub checks and inspect the first failed job log.',
          'Run the matching local validation command if the repo exposes one.',
          'After fixing, rerun failed checks or push an update.',
        ]
      : pr.checks.status === 'pending'
        ? [
            'Wait for pending checks or inspect queued jobs for capacity issues.',
          ]
        : pr.checks.status === 'success'
          ? ['No CI action is needed unless review feedback remains.']
          : ['Confirm whether this repo is expected to publish checks.'];

  return {
    status: pr.checks.status,
    message: `${pr.repo}#${pr.number} CI is ${pr.checks.status}.`,
    facts,
    nextActions,
  };
}

export async function readReviewQueue(
  paths: RuntimePaths,
  dependencies: CommandDependencies,
): Promise<
  | { ok: true; queue: GitHubPullRequestQueue }
  | { ok: false; message: string; errors?: string[]; requires?: string[] }
> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return {
      ok: false,
      message: 'GITHUB_TOKEN is not configured.',
      requires: ['GITHUB_TOKEN'],
    };
  }

  try {
    const registry = await readRepoRegistrySnapshot(paths);
    const fetchLogin = dependencies.fetchGitHubLogin ?? fetchGitHubLogin;
    const fetchQueue =
      dependencies.fetchPullRequestQueue ?? fetchPullRequestQueue;
    const login = process.env.GITHUB_LOGIN ?? (await fetchLogin(token));
    return {
      ok: true,
      queue: await fetchQueue({
        token,
        login,
        repos: registry.repos,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      message: 'Could not fetch GitHub review queue.',
      errors: [errorMessage(error)],
    };
  }
}
