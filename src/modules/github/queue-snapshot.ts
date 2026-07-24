import { createHash } from 'node:crypto';
import type { RuntimePaths } from '../../runtime-home';
import { listGitHubPrQueue } from './actions';
import type {
  GitHubPullRequest,
  GitHubPullRequestQueue,
  GitHubQueueIssue,
} from './schemas';

export const githubQueueRefreshIntervalMs = 3 * 60_000;

export type GitHubQueueSnapshotStatus =
  'loading' | 'ready' | 'degraded' | 'unavailable';

export type GitHubQueueSnapshot = GitHubPullRequestQueue & {
  revision: string;
  status: GitHubQueueSnapshotStatus;
  lastAttemptAt: string | null;
  lastCompleteAt: string | null;
  error?: string;
};

export type GitHubQueueSnapshotEvent = {
  id: string;
  action: 'changed';
  revision: string;
  snapshot: GitHubQueueSnapshot;
  changedAt: string;
};

type GitHubQueueSnapshotState = {
  inFlight: Promise<GitHubQueueSnapshotRefreshResult> | null;
  lastAttemptMs: number | null;
  snapshot: GitHubQueueSnapshot;
};

type GitHubQueueSnapshotRefreshResult = {
  changed: boolean;
  snapshot: GitHubQueueSnapshot;
};

type GitHubQueueSnapshotDependencies = {
  listGitHubPrQueue?: typeof listGitHubPrQueue;
  now?: () => Date;
};

type GitHubQueueSnapshotRegistry = {
  listeners: Set<(event: GitHubQueueSnapshotEvent) => void>;
  states: Map<string, GitHubQueueSnapshotState>;
};

const registry = githubQueueSnapshotRegistry();

export function readGitHubQueueSnapshot(
  paths: RuntimePaths,
): GitHubQueueSnapshot {
  return stateFor(paths).snapshot;
}

export function refreshGitHubQueueSnapshot(
  paths: RuntimePaths,
  dependencies: GitHubQueueSnapshotDependencies = {},
  options: { force?: boolean } = {},
): Promise<GitHubQueueSnapshotRefreshResult> {
  const state = stateFor(paths);
  if (state.inFlight) return state.inFlight;

  const now = (dependencies.now ?? (() => new Date()))();
  if (
    !options.force &&
    state.lastAttemptMs !== null &&
    now.getTime() - state.lastAttemptMs < githubQueueRefreshIntervalMs
  ) {
    return Promise.resolve({ changed: false, snapshot: state.snapshot });
  }

  state.lastAttemptMs = now.getTime();
  state.inFlight = refreshGitHubQueueSnapshotOnce(
    paths,
    state,
    dependencies,
    now,
  ).finally(() => {
    state.inFlight = null;
  });
  return state.inFlight;
}

export function subscribeGitHubQueueSnapshotEvents(
  listener: (event: GitHubQueueSnapshotEvent) => void,
) {
  registry.listeners.add(listener);
  return () => {
    registry.listeners.delete(listener);
  };
}

export function formatGitHubQueueSnapshotServerSentEvent(
  event: GitHubQueueSnapshotEvent,
) {
  return `id: ${event.id}\nevent: github-queue-change\ndata: ${JSON.stringify(event)}\n\n`;
}

export function clearGitHubQueueSnapshotsForTests() {
  registry.states.clear();
}

async function refreshGitHubQueueSnapshotOnce(
  paths: RuntimePaths,
  state: GitHubQueueSnapshotState,
  dependencies: GitHubQueueSnapshotDependencies,
  now: Date,
): Promise<GitHubQueueSnapshotRefreshResult> {
  const previous = state.snapshot;
  const result = await (dependencies.listGitHubPrQueue ?? listGitHubPrQueue)(
    paths,
  );
  const attemptedAt = now.toISOString();
  const queue = readQueue(result);
  let next: GitHubQueueSnapshot;

  if (queue) {
    const searchFailed = queue.issues.some(
      (issue) => issue.type === 'search-error',
    );
    const retainPrevious = searchFailed && previous.lastCompleteAt !== null;
    const source = retainPrevious ? previous : queue;
    const status =
      queue.issues.length > 0 || searchFailed ? 'degraded' : 'ready';
    const error = searchFailed
      ? queue.issues
          .filter((issue) => issue.type === 'search-error')
          .map((issue) => issue.message)
          .join(' ')
      : undefined;

    next = withRevision({
      login: source.login,
      repos: source.repos,
      items: source.items,
      fetchedAt: source.fetchedAt,
      truncated: source.truncated,
      issues: queue.issues,
      status,
      lastAttemptAt: attemptedAt,
      lastCompleteAt: searchFailed ? previous.lastCompleteAt : attemptedAt,
      ...(error ? { error } : {}),
    });
  } else {
    const message = result.message || 'Could not refresh GitHub PR queue.';
    const issues: GitHubQueueIssue[] = (
      result.errors?.length ? result.errors : [message]
    ).map((error) => ({
      type: 'search-error',
      message: error,
    }));
    next = withRevision({
      login: previous.login,
      repos: previous.repos,
      items: previous.items,
      fetchedAt: previous.fetchedAt,
      truncated: previous.truncated,
      issues,
      status:
        previous.lastCompleteAt !== null || previous.items.length > 0
          ? 'degraded'
          : 'unavailable',
      lastAttemptAt: attemptedAt,
      lastCompleteAt: previous.lastCompleteAt,
      error: message,
    });
  }

  const changed = next.revision !== previous.revision;
  state.snapshot = next;
  if (changed) {
    const event: GitHubQueueSnapshotEvent = {
      id: `github-queue:${next.revision}`,
      action: 'changed',
      revision: next.revision,
      snapshot: next,
      changedAt: attemptedAt,
    };
    for (const listener of registry.listeners) listener(event);
  }
  return { changed, snapshot: next };
}

function stateFor(paths: RuntimePaths) {
  const existing = registry.states.get(paths.home);
  if (existing) return existing;
  const snapshot = initialSnapshot();
  const state: GitHubQueueSnapshotState = {
    inFlight: null,
    lastAttemptMs: null,
    snapshot,
  };
  registry.states.set(paths.home, state);
  return state;
}

function initialSnapshot(): GitHubQueueSnapshot {
  const tokenMissing = !process.env.GITHUB_TOKEN;
  return withRevision({
    login: '',
    repos: [],
    items: [],
    fetchedAt: new Date(0).toISOString(),
    truncated: false,
    issues: tokenMissing
      ? [
          {
            type: 'search-error',
            message: 'GITHUB_TOKEN is not configured.',
          },
        ]
      : [],
    status: tokenMissing ? 'unavailable' : 'loading',
    lastAttemptAt: null,
    lastCompleteAt: null,
    ...(tokenMissing ? { error: 'GITHUB_TOKEN is not configured.' } : {}),
  });
}

function readQueue(
  result: Awaited<ReturnType<typeof listGitHubPrQueue>>,
): GitHubPullRequestQueue | null {
  if (!result.ok || !result.data || typeof result.data !== 'object') {
    return null;
  }
  const queue = (result.data as { queue?: unknown }).queue;
  if (!queue || typeof queue !== 'object') return null;
  return queue as GitHubPullRequestQueue;
}

function withRevision(
  snapshot: Omit<GitHubQueueSnapshot, 'revision'>,
): GitHubQueueSnapshot {
  return {
    ...snapshot,
    revision: queueRevision(snapshot),
  };
}

function queueRevision(snapshot: Omit<GitHubQueueSnapshot, 'revision'>) {
  const material = {
    login: snapshot.login,
    repos: snapshot.repos,
    items: snapshot.items.map(materialPullRequest),
    truncated: snapshot.truncated,
    issues: snapshot.issues,
    status: snapshot.status,
    error: snapshot.error ?? null,
  };
  return createHash('sha256')
    .update(JSON.stringify(material))
    .digest('hex')
    .slice(0, 16);
}

function materialPullRequest(item: GitHubPullRequest) {
  return {
    ...item,
    checks: item.checks
      ? {
          ...item.checks,
          checkedAt: undefined,
        }
      : null,
  };
}

function githubQueueSnapshotRegistry(): GitHubQueueSnapshotRegistry {
  const globalRegistry = globalThis as typeof globalThis & {
    __neondeckGitHubQueueSnapshotRegistry?: GitHubQueueSnapshotRegistry;
  };
  globalRegistry.__neondeckGitHubQueueSnapshotRegistry ??= {
    listeners: new Set(),
    states: new Map(),
  };
  return globalRegistry.__neondeckGitHubQueueSnapshotRegistry;
}
