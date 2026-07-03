import { type JsonValue } from '@flue/runtime';
import * as v from 'valibot';
import { failedAction } from './lib/action-result';
import {
  fetchCheckSummary,
  fetchGitHubLogin,
  fetchPullRequestQueue,
} from './github';
import { readRepoRegistrySnapshot, repoFullName } from './repos';
import { type RuntimePaths, runtimePaths } from './runtime-home';

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
  fetchCheckSummary?: typeof fetchCheckSummary;
};

const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));

const checkSummaryInputSchema = v.object({
  repo: nonEmptyStringSchema,
  ref: v.optional(nonEmptyStringSchema),
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
