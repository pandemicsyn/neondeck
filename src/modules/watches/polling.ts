import type { GitHubCheckSummary, GitHubPullRequestDetail } from '../github';
import { fetchCheckSummary, fetchPullRequestDetail } from '../github';
import { readRepoRegistrySnapshot } from '../repos';
import type { RuntimePaths } from '../../runtime-home';
import type {
  CheckFetcher,
  DesiredTerminalState,
  PrWatchSnapshot,
  PrWatchStatus,
  RefWatchSnapshot,
  RefWatchStatus,
  ResolvedPrReference,
  ResolvedRefReference,
  WatchActionResult,
  WatchFetcher,
} from './schemas';
import { resolvePrReference, resolveRefReference } from './references';
import { errorMessage, failResult } from './utils';

export async function resolveWatchId(
  input: { id?: string; ref?: string },
  paths: RuntimePaths,
  action: string,
): Promise<
  { ok: true; id: string } | { ok: false; result: WatchActionResult }
> {
  if (input.id) return { ok: true, id: input.id };
  if (!input.ref) {
    return {
      ok: false,
      result: failResult(action, 'A watch id or PR reference is required.', {
        requires: ['id', 'ref'],
      }),
    };
  }

  const registry = await readRepoRegistrySnapshot(paths);
  const resolved = resolvePrReference(input.ref, registry);
  if (!resolved.ok) return resolved;
  return { ok: true, id: resolved.reference.id };
}

export async function resolveRefWatchId(
  input: { id?: string; repo?: string; ref?: string; target?: string },
  paths: RuntimePaths,
  action: string,
): Promise<
  { ok: true; id: string } | { ok: false; result: WatchActionResult }
> {
  if (input.id) return { ok: true, id: input.id };
  const registry = await readRepoRegistrySnapshot(paths);
  const resolved = resolveRefReference(input, registry);
  if (!resolved.ok) {
    return {
      ok: false,
      result: {
        ...resolved.result,
        action,
      },
    };
  }

  return { ok: true, id: resolved.reference.id };
}

export async function defaultWatchFetcher(reference: ResolvedPrReference) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN is not configured');
  }

  return fetchPullRequestDetail({
    token,
    owner: reference.githubOwner,
    repo: reference.githubName,
    number: reference.prNumber,
  });
}

export async function defaultCheckFetcher(
  reference: ResolvedPrReference | ResolvedRefReference,
  ref: string,
) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN is not configured');
  }

  return fetchCheckSummary({
    token,
    owner: reference.githubOwner,
    repo: reference.githubName,
    ref,
  });
}

export async function fetchWatchDetail(
  action: string,
  reference: ResolvedPrReference,
  fetcher: WatchFetcher,
) {
  try {
    return { ok: true as const, detail: await fetcher(reference) };
  } catch (error) {
    return watchFetchFailure(action, error);
  }
}

export function watchFetchFailure(action: string, error: unknown) {
  return {
    ok: false as const,
    result: failResult(action, 'Could not fetch GitHub PR state.', {
      errors: [errorMessage(error)],
      requires:
        error instanceof Error && error.message.includes('GITHUB_TOKEN')
          ? ['GITHUB_TOKEN']
          : undefined,
    }),
  };
}

export function refFetchFailure(action: string, error: unknown) {
  return {
    ok: false as const,
    result: failResult(action, 'Could not fetch GitHub ref checks.', {
      errors: [errorMessage(error)],
      requires:
        error instanceof Error && error.message.includes('GITHUB_TOKEN')
          ? ['GITHUB_TOKEN']
          : undefined,
    }),
  };
}

export async function snapshotFromDetail(
  detail: GitHubPullRequestDetail,
  reference: ResolvedPrReference,
  checkFetcher: CheckFetcher,
): Promise<PrWatchSnapshot> {
  const checkRef = detail.merged ? detail.mergeCommitSha : null;
  const checks = checkRef
    ? await checkFetcher(reference, checkRef).catch(() => null)
    : null;

  return {
    state: detail.state,
    merged: detail.merged,
    mergeCommitSha: detail.mergeCommitSha,
    checks,
    title: detail.title,
    url: detail.url,
    updatedAt: detail.updatedAt,
    headSha: detail.headSha,
    baseRef: detail.baseRef,
  };
}

export async function snapshotFromRef(
  reference: ResolvedRefReference,
  checkFetcher: CheckFetcher,
  action: string,
): Promise<
  | { ok: true; snapshot: RefWatchSnapshot }
  | { ok: false; result: WatchActionResult }
> {
  try {
    const checks = await checkFetcher(reference, reference.ref);
    return {
      ok: true,
      snapshot: {
        ref: reference.ref,
        checks,
        url: refUrl(reference),
        checkedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    return refFetchFailure(action, error);
  }
}

export function statusFromSnapshot(
  snapshot: PrWatchSnapshot,
  desiredTerminalState: DesiredTerminalState,
): PrWatchStatus {
  if (
    desiredTerminalState === 'merged' &&
    snapshot.state === 'closed' &&
    snapshot.merged
  ) {
    return 'merged';
  }
  if (snapshot.checks?.status === 'success') return 'green';
  if (snapshot.checks?.status === 'failure') return 'attention-needed';
  if (snapshot.state === 'closed' && snapshot.merged) return 'watching';
  if (snapshot.state === 'closed') return 'closed';
  if (snapshot.state === 'open') return 'watching';
  return 'unknown';
}

export function refStatusFromChecks(
  checks: GitHubCheckSummary,
): RefWatchStatus {
  if (checks.status === 'success') return 'green';
  if (checks.status === 'failure') return 'attention-needed';
  if (checks.status === 'pending' || checks.status === 'none') {
    return 'watching';
  }
  return 'unknown';
}

export function meaningfulRefSnapshot(snapshot: RefWatchSnapshot | null) {
  if (!snapshot) return '';
  return JSON.stringify({
    ref: snapshot.ref,
    url: snapshot.url,
    checks: snapshot.checks,
  });
}

export function refUrl(reference: ResolvedRefReference) {
  const path = /^[a-f0-9]{40}$/i.test(reference.ref) ? 'commit' : 'tree';
  const encodedRef = reference.ref.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${reference.repoFullName}/${path}/${encodedRef}`;
}
