/* eslint-disable no-unused-vars */
import { defineAction, defineTool, type JsonValue } from '@flue/runtime';
import type { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import {
  fetchPullRequestEventState,
  postPullRequestComment,
  type GitHubPullRequestEventState,
} from '../github';
import { readRepoRegistrySnapshot, repoFullName } from '../repos';
import {
  type RuntimePaths,
  ensureRuntimeHome,
  runtimePaths,
} from '../../runtime-home';
import {
  listPrWatchRecords,
  parseWatchPrReference,
  type PrWatch,
} from '../watches';
import {
  prEventTargetInputSchema,
  type PrEventActionResult,
  type PrEventStateDependencies,
  type PullRequestTarget,
} from './schemas';
import { errorMessage, failResult } from './utils';

export async function fetchEventState(
  action: string,
  input: v.InferInput<typeof prEventTargetInputSchema>,
  paths: RuntimePaths,
  dependencies: PrEventStateDependencies,
): Promise<
  | {
      ok: true;
      target: PullRequestTarget;
      state: GitHubPullRequestEventState;
    }
  | { ok: false; result: PrEventActionResult }
> {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(prEventTargetInputSchema, input);
  if (!parsed.success) {
    return {
      ok: false,
      result: failResult(action, 'Invalid PR event state input.', {
        errors: [v.summarize(parsed.issues)],
      }),
    };
  }

  const token = dependencies.token ?? process.env.GITHUB_TOKEN;
  if (!token) {
    return {
      ok: false,
      result: failResult(action, 'GITHUB_TOKEN is not configured.', {
        requires: ['GITHUB_TOKEN'],
      }),
    };
  }

  const target = await resolvePullRequestTarget(parsed.output, paths, action);
  if (!target.ok) return target;

  try {
    const fetcher =
      dependencies.fetchPullRequestEventState ?? fetchPullRequestEventState;
    return {
      ok: true,
      target: target.target,
      state: await fetcher({
        token,
        owner: target.target.owner,
        repo: target.target.repo,
        number: target.target.number,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      result: failResult(action, 'Could not fetch GitHub PR event state.', {
        errors: [errorMessage(error)],
      }),
    };
  }
}

export async function resolvePullRequestTarget(
  input: v.InferOutput<typeof prEventTargetInputSchema>,
  paths: RuntimePaths,
  action: string,
): Promise<
  | { ok: true; target: PullRequestTarget }
  | { ok: false; result: PrEventActionResult }
> {
  const watches = await listPrWatchRecords(paths);
  if (input.watchId) {
    const watch = watches.find((item) => item.id === input.watchId);
    if (!watch) {
      return {
        ok: false,
        result: failResult(action, `PR watch "${input.watchId}" not found.`, {
          requires: ['watchId'],
        }),
      };
    }

    return { ok: true, target: targetFromWatch(watch) };
  }

  if (input.ref) {
    const registry = await readRepoRegistrySnapshot(paths);
    const parsed = parseWatchPrReference(input.ref, registry);
    if (!parsed.ok) {
      return {
        ok: false,
        result: {
          ok: false,
          action,
          changed: false,
          message: parsed.result.message,
          requires: parsed.result.requires,
          errors: parsed.result.errors,
        },
      };
    }
    const watch = watches.find((item) => item.id === parsed.reference.id);
    return {
      ok: true,
      target: {
        repoFullName: parsed.reference.repoFullName,
        owner: parsed.reference.githubOwner,
        repo: parsed.reference.githubName,
        number: parsed.reference.prNumber,
        ...(watch ? { watch } : {}),
      },
    };
  }

  if (!input.repo || !input.prNumber) {
    return {
      ok: false,
      result: failResult(
        action,
        'A watchId, ref, or repo plus prNumber is required.',
        { requires: ['watchId', 'ref', 'repo', 'prNumber'] },
      ),
    };
  }

  const registry = await readRepoRegistrySnapshot(paths);
  const repo = registry.repos.find(
    (item) =>
      item.id === input.repo ||
      item.github.name === input.repo ||
      repoFullName(item).toLowerCase() === input.repo?.toLowerCase(),
  );
  if (repo) {
    const fullName = repoFullName(repo);
    const watch = watches.find(
      (item) =>
        item.repoFullName.toLowerCase() === fullName.toLowerCase() &&
        item.prNumber === input.prNumber,
    );
    return {
      ok: true,
      target: {
        repoFullName: fullName,
        owner: repo.github.owner,
        repo: repo.github.name,
        number: input.prNumber,
        ...(watch ? { watch } : {}),
      },
    };
  }

  const match = input.repo.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) {
    return {
      ok: false,
      result: failResult(
        action,
        `Repository "${input.repo}" is not configured.`,
        {
          requires: ['repo'],
        },
      ),
    };
  }

  return {
    ok: true,
    target: {
      repoFullName: `${match[1]}/${match[2]}`,
      owner: match[1],
      repo: match[2],
      number: input.prNumber,
    },
  };
}

export function targetFromWatch(watch: PrWatch): PullRequestTarget {
  return {
    repoFullName: watch.repoFullName,
    owner: watch.githubOwner,
    repo: watch.githubName,
    number: watch.prNumber,
    watch,
  };
}

export async function isConfiguredRepoTarget(
  target: PullRequestTarget,
  paths: RuntimePaths,
) {
  const registry = await readRepoRegistrySnapshot(paths);
  return registry.repos.some(
    (repo) =>
      repoFullName(repo).toLowerCase() === target.repoFullName.toLowerCase(),
  );
}
