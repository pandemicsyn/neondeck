import { type JsonValue } from '@flue/runtime';
import * as v from 'valibot';
import { failedAction } from '../../lib/action-result';
import { fetchCheckSummary } from './checks';
import { fetchGitHubLogin } from './client';
import { fetchGitHubIssues } from './issues';
import { fetchPullRequestDetail } from './pull-requests';
import { fetchPullRequestQueue } from './queue';
import { readRepoRegistrySnapshot, repoFullName } from '../repos';
import { type RuntimePaths, runtimePaths } from '../../runtime-home';
import type { GitHubPullRequest } from './schemas';

type GitHubActionResult<TData extends JsonValue = JsonValue> = {
  ok: boolean;
  action: string;
  changed: false;
  message: string;
  data?: TData;
  requires?: string[];
  errors?: string[];
};

type GitHubActionDependencies = {
  fetchGitHubLogin?: typeof fetchGitHubLogin;
  fetchPullRequestQueue?: typeof fetchPullRequestQueue;
  fetchPullRequestDetail?: typeof fetchPullRequestDetail;
  fetchCheckSummary?: typeof fetchCheckSummary;
  fetchGitHubIssues?: typeof fetchGitHubIssues;
};

const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));

const checkSummaryInputSchema = v.object({
  repo: nonEmptyStringSchema,
  ref: v.optional(nonEmptyStringSchema),
});
const issuesInputSchema = v.object({
  repo: nonEmptyStringSchema,
  since: v.optional(nonEmptyStringSchema),
  limit: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(200)),
  ),
});
const pullRequestInputSchema = v.object({
  repo: nonEmptyStringSchema,
  number: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

export async function listGitHubPrQueue(
  paths: RuntimePaths = runtimePaths(),
  dependencies: GitHubActionDependencies = {},
): Promise<GitHubActionResult> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return failResult(
      'github_pr_queue_list',
      'GITHUB_TOKEN is not configured.',
      {
        requires: ['GITHUB_TOKEN'],
      },
    );
  }

  try {
    const registry = await readRepoRegistrySnapshot(paths);
    const fetchLogin = dependencies.fetchGitHubLogin ?? fetchGitHubLogin;
    const fetchQueue =
      dependencies.fetchPullRequestQueue ?? fetchPullRequestQueue;
    const login = process.env.GITHUB_LOGIN ?? (await fetchLogin(token));
    const queue = await fetchQueue({
      token,
      login,
      repos: registry.repos,
    });

    return okResult(
      'github_pr_queue_list',
      `Fetched ${queue.items.length} GitHub pull requests.`,
      { queue: queue as unknown as JsonValue },
    );
  } catch (error) {
    return failResult(
      'github_pr_queue_list',
      'Could not fetch GitHub PR queue.',
      {
        errors: [errorMessage(error)],
      },
    );
  }
}

export async function getGitHubPullRequest(
  input: v.InferInput<typeof pullRequestInputSchema>,
  paths: RuntimePaths = runtimePaths(),
  dependencies: GitHubActionDependencies = {},
): Promise<GitHubActionResult> {
  const parsed = v.safeParse(pullRequestInputSchema, input);
  if (!parsed.success) {
    return failResult(
      'github_pull_request_get',
      'Invalid pull request input.',
      {
        errors: [v.summarize(parsed.issues)],
      },
    );
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return failResult(
      'github_pull_request_get',
      'GITHUB_TOKEN is not configured.',
      { requires: ['GITHUB_TOKEN'] },
    );
  }

  const repoParts = parsed.output.repo.split('/');
  if (repoParts.length !== 2 || !repoParts[0] || !repoParts[1]) {
    return failResult('github_pull_request_get', 'Invalid repository name.', {
      requires: ['repo'],
    });
  }
  const [owner, repo] = repoParts;

  try {
    const fetchDetail =
      dependencies.fetchPullRequestDetail ?? fetchPullRequestDetail;
    const detail = await fetchDetail({
      token,
      owner,
      repo,
      number: parsed.output.number,
    });
    let checkError: string | undefined;
    const checks = await (dependencies.fetchCheckSummary ?? fetchCheckSummary)({
      token,
      owner,
      repo,
      ref: detail.headSha,
    }).catch((error: unknown) => {
      checkError = errorMessage(error);
      return null;
    });
    const pullRequest: GitHubPullRequest = {
      id: detail.id ?? parsed.output.number,
      title: detail.title,
      repo: detail.repo,
      number: detail.number,
      url: detail.url,
      state: detail.state,
      draft: detail.draft ?? false,
      author: detail.author ?? 'unknown',
      labels: detail.labels ?? [],
      comments: detail.comments ?? 0,
      updatedAt: detail.updatedAt,
      createdAt: detail.createdAt ?? detail.updatedAt,
      relations: [],
      ageDays: ageDays(detail.updatedAt),
      stale: isStale(detail.updatedAt),
      headSha: detail.headSha,
      baseRef: detail.baseRef,
      checks,
      ...(checkError ? { checkError } : {}),
    };

    return okResult(
      'github_pull_request_get',
      `Fetched ${pullRequest.repo}#${pullRequest.number}.`,
      { pullRequest: pullRequest as unknown as JsonValue },
    );
  } catch (error) {
    return failResult(
      'github_pull_request_get',
      'Could not fetch GitHub pull request.',
      { errors: [errorMessage(error)] },
    );
  }
}

export async function getGitHubCheckSummary(
  input: v.InferInput<typeof checkSummaryInputSchema>,
  paths: RuntimePaths = runtimePaths(),
  dependencies: GitHubActionDependencies = {},
): Promise<GitHubActionResult> {
  const parsed = v.safeParse(checkSummaryInputSchema, input);
  if (!parsed.success) {
    return failResult(
      'github_check_summary_get',
      'Invalid check summary input.',
      {
        errors: [v.summarize(parsed.issues)],
      },
    );
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return failResult(
      'github_check_summary_get',
      'GITHUB_TOKEN is not configured.',
      { requires: ['GITHUB_TOKEN'] },
    );
  }

  try {
    const registry = await readRepoRegistrySnapshot(paths);
    const repo = registry.repos.find(
      (item) =>
        item.id === parsed.output.repo ||
        item.github.name === parsed.output.repo ||
        repoFullName(item).toLowerCase() === parsed.output.repo.toLowerCase(),
    );
    if (!repo) {
      return failResult(
        'github_check_summary_get',
        `Repository "${parsed.output.repo}" is not configured.`,
        { requires: ['repo'] },
      );
    }

    const ref = parsed.output.ref ?? repo.defaultBranch;
    const checks = await (dependencies.fetchCheckSummary ?? fetchCheckSummary)({
      token,
      owner: repo.github.owner,
      repo: repo.github.name,
      ref,
    });

    return okResult(
      'github_check_summary_get',
      `Fetched checks for ${repoFullName(repo)}@${ref}.`,
      {
        repo: repo.id,
        repoFullName: repoFullName(repo),
        ref,
        checks: checks as unknown as JsonValue,
      },
    );
  } catch (error) {
    return failResult(
      'github_check_summary_get',
      'Could not fetch GitHub check summary.',
      { errors: [errorMessage(error)] },
    );
  }
}

export async function listGitHubIssues(
  input: v.InferInput<typeof issuesInputSchema>,
  paths: RuntimePaths = runtimePaths(),
  dependencies: GitHubActionDependencies = {},
): Promise<GitHubActionResult> {
  const parsed = v.safeParse(issuesInputSchema, input);
  if (!parsed.success) {
    return failResult('github_issues_list', 'Invalid issues input.', {
      errors: [v.summarize(parsed.issues)],
    });
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return failResult('github_issues_list', 'GITHUB_TOKEN is not configured.', {
      requires: ['GITHUB_TOKEN'],
    });
  }

  try {
    const registry = await readRepoRegistrySnapshot(paths);
    const repo = registry.repos.find(
      (item) =>
        item.id === parsed.output.repo ||
        item.github.name === parsed.output.repo ||
        repoFullName(item).toLowerCase() === parsed.output.repo.toLowerCase(),
    );
    if (!repo) {
      return failResult(
        'github_issues_list',
        `Repository "${parsed.output.repo}" is not configured.`,
        { requires: ['repo'] },
      );
    }
    const issues = await (dependencies.fetchGitHubIssues ?? fetchGitHubIssues)({
      token,
      owner: repo.github.owner,
      repo: repo.github.name,
      since: parsed.output.since,
      limit: parsed.output.limit,
    });
    return okResult(
      'github_issues_list',
      `Fetched ${issues.items.length} GitHub issues.`,
      {
        repo: repo.id,
        repoFullName: repoFullName(repo),
        issues: issues as unknown as JsonValue,
      },
    );
  } catch (error) {
    return failResult('github_issues_list', 'Could not fetch GitHub issues.', {
      errors: [errorMessage(error)],
    });
  }
}

function okResult(
  action: string,
  message: string,
  data: JsonValue,
): GitHubActionResult {
  return {
    ok: true,
    action,
    changed: false,
    message,
    data,
  };
}

const failResult = failedAction<
  Pick<GitHubActionResult, 'errors' | 'requires'>
>;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function ageDays(value: string) {
  return Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 86_400_000));
}

function isStale(value: string) {
  return ageDays(value) >= 7;
}
