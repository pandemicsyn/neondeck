import { defineAction, type JsonValue } from '@flue/runtime';
import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import { deleteJob, deleteJobsByConfigField, upsertJob } from './app-state';
import {
  type GitHubCheckSummary,
  type GitHubPullRequestDetail,
  fetchCheckSummary,
  fetchPullRequestDetail,
} from './github';
import {
  type RepoRegistrySnapshot,
  readRepoRegistrySnapshot,
  repoFullName,
} from './repos';
import {
  type RuntimePaths,
  ensureRuntimeHome,
  runtimePaths,
} from './runtime-home';

export type PrWatchStatus =
  'watching' | 'merged' | 'closed' | 'green' | 'attention-needed' | 'unknown';

export type DesiredTerminalState = 'checks' | 'merged' | 'prod';
type WatchOutcome = 'created' | 'updated' | 'removed' | 'silent';

export type WatchActionResult = {
  ok: boolean;
  action: string;
  changed: boolean;
  outcome?: WatchOutcome;
  message: string;
  watch?: JsonValue;
  watches?: JsonValue[];
  requires?: string[];
  errors?: string[];
};

export type PrWatch = {
  id: string;
  repoId: string;
  repoFullName: string;
  githubOwner: string;
  githubName: string;
  prNumber: number;
  desiredTerminalState: DesiredTerminalState;
  status: PrWatchStatus;
  prState: string | null;
  title: string | null;
  url: string | null;
  mergeCommitSha: string | null;
  lastSnapshot: PrWatchSnapshot | null;
  lastOutcome: WatchOutcome | null;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type PrWatchSnapshot = {
  state: string;
  merged: boolean;
  mergeCommitSha: string | null;
  checks: GitHubCheckSummary | null;
  title: string;
  url: string;
  updatedAt: string;
  headSha: string;
  baseRef: string;
};

type ResolvedPrReference = {
  id: string;
  repoId: string;
  repoFullName: string;
  githubOwner: string;
  githubName: string;
  prNumber: number;
  desiredTerminalState: DesiredTerminalState;
};

type WatchFetcher = (
  watch: ResolvedPrReference,
) => Promise<GitHubPullRequestDetail>;
type CheckFetcher = (
  watch: ResolvedPrReference,
  ref: string,
) => Promise<GitHubCheckSummary>;

const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
const desiredTerminalStateSchema = v.optional(
  v.picklist(['checks', 'merged', 'prod']),
);

const watchPrAddInputSchema = v.object({
  ref: nonEmptyStringSchema,
  desiredTerminalState: desiredTerminalStateSchema,
  intervalSeconds: v.optional(v.pipe(v.number(), v.integer(), v.minValue(60))),
});

const watchPrRemoveInputSchema = v.object({
  id: v.optional(nonEmptyStringSchema),
  ref: v.optional(nonEmptyStringSchema),
  confirm: v.optional(v.boolean()),
});

const watchPrRefreshInputSchema = v.object({
  id: v.optional(nonEmptyStringSchema),
  ref: v.optional(nonEmptyStringSchema),
});
const watchActionOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
});

export const watchPrAddAction = defineAction({
  name: 'neondeck_watch_pr_add',
  description:
    'Create a persistent PR watch from a GitHub PR URL, owner/repo#number, repo#number, or #number reference.',
  input: watchPrAddInputSchema,
  output: watchActionOutputSchema,
  async run({ input }) {
    return addPrWatch(input);
  },
});

export const watchPrListAction = defineAction({
  name: 'neondeck_watch_pr_list',
  description: 'List persistent Neondeck PR watches.',
  input: v.object({}),
  output: watchActionOutputSchema,
  async run() {
    return listPrWatches();
  },
});

export const watchPrRemoveAction = defineAction({
  name: 'neondeck_watch_pr_remove',
  description: 'Remove a persistent PR watch after explicit confirmation.',
  input: watchPrRemoveInputSchema,
  output: watchActionOutputSchema,
  async run({ input }) {
    return removePrWatch(input);
  },
});

export const watchPrRefreshAction = defineAction({
  name: 'neondeck_watch_pr_refresh',
  description:
    'Refresh one persistent PR watch and return silent when no meaningful state changed.',
  input: watchPrRefreshInputSchema,
  output: watchActionOutputSchema,
  async run({ input }) {
    return refreshPrWatch(input);
  },
});

export const neondeckWatchActions = [
  watchPrAddAction,
  watchPrRemoveAction,
  watchPrRefreshAction,
];

export async function addPrWatch(
  input: v.InferInput<typeof watchPrAddInputSchema>,
  paths = runtimePaths(),
  fetcher: WatchFetcher = defaultWatchFetcher,
  checkFetcher: CheckFetcher = defaultCheckFetcher,
): Promise<WatchActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(watchPrAddInputSchema, input, 'watch_pr_add');
  if (!parsed.ok) return parsed.result;

  const registry = await readRepoRegistrySnapshot(paths);
  const resolved = resolvePrReference(
    parsed.input.ref,
    registry,
    parsed.input.desiredTerminalState,
  );
  if (!resolved.ok) return resolved.result;

  const existing = readWatch(paths, resolved.reference.id);
  if (existing) {
    return failResult('watch_pr_add', `Watch "${existing.id}" already exists.`);
  }

  const detail = await fetchWatchDetail(
    'watch_pr_add',
    resolved.reference,
    fetcher,
  );
  if (!detail.ok) return detail.result;

  const now = new Date().toISOString();
  const snapshot = await snapshotFromDetail(
    detail.detail,
    resolved.reference,
    checkFetcher,
  );
  const watch: PrWatch = {
    id: resolved.reference.id,
    repoId: resolved.reference.repoId,
    repoFullName: resolved.reference.repoFullName,
    githubOwner: resolved.reference.githubOwner,
    githubName: resolved.reference.githubName,
    prNumber: resolved.reference.prNumber,
    desiredTerminalState: resolved.reference.desiredTerminalState,
    status: statusFromSnapshot(
      snapshot,
      resolved.reference.desiredTerminalState,
    ),
    prState: snapshot.state,
    title: snapshot.title,
    url: snapshot.url,
    mergeCommitSha: snapshot.mergeCommitSha,
    lastSnapshot: snapshot,
    lastOutcome: 'created',
    lastCheckedAt: now,
    createdAt: now,
    updatedAt: now,
  };

  insertWatch(paths, watch);
  await upsertWatchPollingJob(watch, paths, parsed.input.intervalSeconds);
  if (watch.desiredTerminalState === 'prod') {
    await upsertReleasePollingJob(watch, paths);
  }

  return okResult('watch_pr_add', true, 'created', `Watching ${watch.id}.`, {
    watch,
  });
}

export async function listPrWatches(
  paths = runtimePaths(),
): Promise<WatchActionResult> {
  await ensureRuntimeHome(paths);
  return okResult('watch_pr_list', false, undefined, 'Listed PR watches.', {
    watches: readWatches(paths),
  });
}

export async function listPrWatchRecords(paths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  return readWatches(paths);
}

export async function removePrWatch(
  input: v.InferInput<typeof watchPrRemoveInputSchema>,
  paths = runtimePaths(),
): Promise<WatchActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    watchPrRemoveInputSchema,
    input,
    'watch_pr_remove',
  );
  if (!parsed.ok) return parsed.result;
  if (parsed.input.confirm !== true) {
    return failResult(
      'watch_pr_remove',
      'Removing a PR watch requires confirmation.',
      {
        requires: ['confirm'],
      },
    );
  }

  const idResult = await resolveWatchId(parsed.input, paths, 'watch_pr_remove');
  if (!idResult.ok) return idResult.result;

  const watch = readWatch(paths, idResult.id);
  if (!watch) {
    return failResult(
      'watch_pr_remove',
      `Watch "${idResult.id}" does not exist.`,
    );
  }

  deleteWatch(paths, idResult.id);
  await deleteJob(watchPollingJobId(idResult.id), paths);
  await deleteJobsByConfigField('sourceWatchId', idResult.id, paths);
  return okResult(
    'watch_pr_remove',
    true,
    'removed',
    `Removed watch "${idResult.id}".`,
    {
      watch,
    },
  );
}

export async function refreshPrWatch(
  input: v.InferInput<typeof watchPrRefreshInputSchema>,
  paths = runtimePaths(),
  fetcher: WatchFetcher = defaultWatchFetcher,
  checkFetcher: CheckFetcher = defaultCheckFetcher,
): Promise<WatchActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    watchPrRefreshInputSchema,
    input,
    'watch_pr_refresh',
  );
  if (!parsed.ok) return parsed.result;

  const idResult = await resolveWatchId(
    parsed.input,
    paths,
    'watch_pr_refresh',
  );
  if (!idResult.ok) return idResult.result;

  const watch = readWatch(paths, idResult.id);
  if (!watch) {
    return failResult(
      'watch_pr_refresh',
      `Watch "${idResult.id}" does not exist.`,
    );
  }

  const reference: ResolvedPrReference = {
    id: watch.id,
    repoId: watch.repoId,
    repoFullName: watch.repoFullName,
    githubOwner: watch.githubOwner,
    githubName: watch.githubName,
    prNumber: watch.prNumber,
    desiredTerminalState: watch.desiredTerminalState,
  };
  const detail = await fetchWatchDetail('watch_pr_refresh', reference, fetcher);
  if (!detail.ok) return detail.result;

  const snapshot = await snapshotFromDetail(
    detail.detail,
    reference,
    checkFetcher,
  );
  const nextStatus = statusFromSnapshot(snapshot, watch.desiredTerminalState);
  const changed =
    JSON.stringify(watch.lastSnapshot) !== JSON.stringify(snapshot) ||
    watch.status !== nextStatus;
  const now = new Date().toISOString();
  const nextWatch: PrWatch = {
    ...watch,
    status: nextStatus,
    prState: snapshot.state,
    title: snapshot.title,
    url: snapshot.url,
    mergeCommitSha: snapshot.mergeCommitSha,
    lastSnapshot: snapshot,
    lastOutcome: changed ? 'updated' : 'silent',
    lastCheckedAt: now,
    updatedAt: now,
  };

  updateWatch(paths, nextWatch);

  return okResult(
    'watch_pr_refresh',
    changed,
    changed ? 'updated' : 'silent',
    changed
      ? `Updated watch "${watch.id}".`
      : `No change for watch "${watch.id}".`,
    { watch: nextWatch },
  );
}

export function parseWatchPrReference(
  input: string,
  registry: Pick<RepoRegistrySnapshot, 'repos'>,
  desiredTerminalState?: DesiredTerminalState,
) {
  return resolvePrReference(input, registry, desiredTerminalState);
}

function resolvePrReference(
  input: string,
  registry: Pick<RepoRegistrySnapshot, 'repos'>,
  explicitDesiredTerminalState?: DesiredTerminalState,
):
  | { ok: true; reference: ResolvedPrReference }
  | { ok: false; result: WatchActionResult } {
  const desiredFromInput = readDesiredTerminalState(input);
  const desiredTerminalState =
    explicitDesiredTerminalState ?? desiredFromInput.state ?? 'checks';
  const ref = desiredFromInput.ref;
  const urlMatch = ref.match(
    /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)\/?$/i,
  );

  if (urlMatch) {
    return okReference({
      repoId: `${urlMatch[1]}/${urlMatch[2]}`,
      githubOwner: urlMatch[1],
      githubName: urlMatch[2],
      prNumber: Number(urlMatch[3]),
      desiredTerminalState,
    });
  }

  const fullNameMatch = ref.match(/^([^/\s#]+)\/([^/\s#]+)#(\d+)$/);
  if (fullNameMatch) {
    return okReference({
      repoId: `${fullNameMatch[1]}/${fullNameMatch[2]}`,
      githubOwner: fullNameMatch[1],
      githubName: fullNameMatch[2],
      prNumber: Number(fullNameMatch[3]),
      desiredTerminalState,
    });
  }

  const repoMatch = ref.match(/^([^#\s]+)#(\d+)$/);
  if (repoMatch) {
    const repo = findConfiguredRepo(registry.repos, repoMatch[1]);
    if (!repo.ok) return repo;

    return okReference({
      repoId: repo.repo.id,
      githubOwner: repo.repo.github.owner,
      githubName: repo.repo.github.name,
      prNumber: Number(repoMatch[2]),
      desiredTerminalState,
    });
  }

  const numberMatch = ref.match(/^#(\d+)$/);
  if (numberMatch) {
    if (registry.repos.length !== 1) {
      return {
        ok: false,
        result: failResult(
          'watch_pr_parse',
          'A bare PR number requires exactly one configured repo.',
          { requires: ['repo'] },
        ),
      };
    }

    const repo = registry.repos[0];
    return okReference({
      repoId: repo.id,
      githubOwner: repo.github.owner,
      githubName: repo.github.name,
      prNumber: Number(numberMatch[1]),
      desiredTerminalState,
    });
  }

  return {
    ok: false,
    result: failResult(
      'watch_pr_parse',
      `Could not parse PR reference "${input}".`,
      {
        requires: ['ref'],
      },
    ),
  };
}

function readDesiredTerminalState(input: string) {
  const match = input.match(/\s+until\s+(prod|checks|merged?)\s*$/i);
  if (!match) return { ref: input.trim(), state: undefined };

  const rawState = match[1].toLowerCase();
  const state: DesiredTerminalState = rawState.startsWith('merge')
    ? 'merged'
    : (rawState as DesiredTerminalState);

  return {
    ref: input.slice(0, match.index).trim(),
    state,
  };
}

function findConfiguredRepo(
  repos: RepoRegistrySnapshot['repos'],
  value: string,
):
  | { ok: true; repo: RepoRegistrySnapshot['repos'][number] }
  | { ok: false; result: WatchActionResult } {
  const matches = repos.filter(
    (repo) =>
      repo.id === value ||
      repo.github.name === value ||
      repoFullName(repo).toLowerCase() === value.toLowerCase(),
  );

  if (matches.length === 1) {
    return { ok: true, repo: matches[0] };
  }

  if (matches.length > 1) {
    return {
      ok: false,
      result: failResult(
        'watch_pr_parse',
        `Repository "${value}" is ambiguous.`,
        {
          requires: ['repo'],
        },
      ),
    };
  }

  return {
    ok: false,
    result: failResult(
      'watch_pr_parse',
      `Repository "${value}" is not configured.`,
      {
        requires: ['repo'],
      },
    ),
  };
}

function okReference(input: Omit<ResolvedPrReference, 'id' | 'repoFullName'>): {
  ok: true;
  reference: ResolvedPrReference;
} {
  const repoFullNameValue = `${input.githubOwner}/${input.githubName}`;
  const reference = {
    ...input,
    repoFullName: repoFullNameValue,
    id: `${repoFullNameValue}#${input.prNumber}`,
  };

  return { ok: true, reference };
}

async function resolveWatchId(
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

async function defaultWatchFetcher(reference: ResolvedPrReference) {
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

async function defaultCheckFetcher(
  reference: ResolvedPrReference,
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

async function fetchWatchDetail(
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

function watchFetchFailure(action: string, error: unknown) {
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

async function snapshotFromDetail(
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

function statusFromSnapshot(
  snapshot: PrWatchSnapshot,
  desiredTerminalState: DesiredTerminalState,
): PrWatchStatus {
  if (snapshot.checks?.status === 'success') return 'green';
  if (snapshot.checks?.status === 'failure') return 'attention-needed';
  if (snapshot.state === 'closed' && snapshot.merged) {
    return desiredTerminalState === 'merged' ? 'merged' : 'watching';
  }
  if (snapshot.state === 'closed') return 'closed';
  if (snapshot.state === 'open') return 'watching';
  return 'unknown';
}

function insertWatch(paths: RuntimePaths, watch: PrWatch) {
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        INSERT INTO pr_watches (
          id,
          repo_id,
          repo_full_name,
          github_owner,
          github_name,
          pr_number,
          desired_terminal_state,
          status,
          pr_state,
          title,
          url,
          merge_commit_sha,
          last_snapshot_json,
          last_outcome,
          last_checked_at,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      )
      .run(...watchParams(watch));
  } finally {
    database.close();
  }
}

function updateWatch(paths: RuntimePaths, watch: PrWatch) {
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        UPDATE pr_watches
        SET
          repo_id = ?,
          repo_full_name = ?,
          github_owner = ?,
          github_name = ?,
          pr_number = ?,
          desired_terminal_state = ?,
          status = ?,
          pr_state = ?,
          title = ?,
          url = ?,
          merge_commit_sha = ?,
          last_snapshot_json = ?,
          last_outcome = ?,
          last_checked_at = ?,
          updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(
        watch.repoId,
        watch.repoFullName,
        watch.githubOwner,
        watch.githubName,
        watch.prNumber,
        watch.desiredTerminalState,
        watch.status,
        watch.prState,
        watch.title,
        watch.url,
        watch.mergeCommitSha,
        watch.lastSnapshot ? JSON.stringify(watch.lastSnapshot) : null,
        watch.lastOutcome,
        watch.lastCheckedAt,
        watch.updatedAt,
        watch.id,
      );
  } finally {
    database.close();
  }
}

function upsertWatchPollingJob(
  watch: PrWatch,
  paths: RuntimePaths,
  intervalSeconds = 300,
) {
  return upsertJob(
    {
      id: watchPollingJobId(watch.id),
      type: 'watch-pr',
      blueprint: 'watch-pr',
      enabled: true,
      intervalSeconds,
      config: {
        id: watch.id,
        repo: watch.repoFullName,
        prNumber: watch.prNumber,
      },
    },
    paths,
  );
}

function watchPollingJobId(id: string) {
  return `watch:${id}`;
}

function upsertReleasePollingJob(watch: PrWatch, paths: RuntimePaths) {
  return upsertJob(
    {
      id: releasePollingJobId(watch.repoId),
      type: 'release-watch',
      blueprint: 'release-watch',
      enabled: true,
      intervalSeconds: 900,
      config: {
        repo: watch.repoId,
        source: 'watch-pr-until-prod',
        sourceWatchId: watch.id,
      },
    },
    paths,
  );
}

function releasePollingJobId(repoId: string) {
  return `release:${repoId}`;
}

function readWatches(paths: RuntimePaths): PrWatch[] {
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    return database
      .prepare(
        `
        SELECT *
        FROM pr_watches
        ORDER BY updated_at DESC, created_at DESC;
      `,
      )
      .all()
      .map(readWatchRow);
  } finally {
    database.close();
  }
}

function readWatch(paths: RuntimePaths, id: string) {
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    const row = database
      .prepare(
        `
        SELECT *
        FROM pr_watches
        WHERE id = ?;
      `,
      )
      .get(id);

    return row ? readWatchRow(row) : undefined;
  } finally {
    database.close();
  }
}

function deleteWatch(paths: RuntimePaths, id: string) {
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database.prepare('DELETE FROM pr_watches WHERE id = ?;').run(id);
  } finally {
    database.close();
  }
}

function watchParams(watch: PrWatch) {
  return [
    watch.id,
    watch.repoId,
    watch.repoFullName,
    watch.githubOwner,
    watch.githubName,
    watch.prNumber,
    watch.desiredTerminalState,
    watch.status,
    watch.prState,
    watch.title,
    watch.url,
    watch.mergeCommitSha,
    watch.lastSnapshot ? JSON.stringify(watch.lastSnapshot) : null,
    watch.lastOutcome,
    watch.lastCheckedAt,
    watch.createdAt,
    watch.updatedAt,
  ];
}

function readWatchRow(row: unknown): PrWatch {
  const record = row as Record<string, unknown>;
  const snapshot =
    typeof record.last_snapshot_json === 'string'
      ? (JSON.parse(record.last_snapshot_json) as PrWatchSnapshot)
      : null;

  return {
    id: String(record.id),
    repoId: String(record.repo_id),
    repoFullName: String(record.repo_full_name),
    githubOwner: String(record.github_owner),
    githubName: String(record.github_name),
    prNumber: Number(record.pr_number),
    desiredTerminalState: String(
      record.desired_terminal_state,
    ) as DesiredTerminalState,
    status: String(record.status) as PrWatchStatus,
    prState:
      typeof record.pr_state === 'string' ? String(record.pr_state) : null,
    title: typeof record.title === 'string' ? String(record.title) : null,
    url: typeof record.url === 'string' ? String(record.url) : null,
    mergeCommitSha:
      typeof record.merge_commit_sha === 'string'
        ? String(record.merge_commit_sha)
        : null,
    lastSnapshot: snapshot,
    lastOutcome:
      typeof record.last_outcome === 'string'
        ? (String(record.last_outcome) as WatchOutcome)
        : null,
    lastCheckedAt:
      typeof record.last_checked_at === 'string'
        ? String(record.last_checked_at)
        : null,
    createdAt: String(record.created_at),
    updatedAt: String(record.updated_at),
  };
}

function parseActionInput<T>(
  schema: v.GenericSchema<unknown, T>,
  input: unknown,
  action: string,
) {
  const result = v.safeParse(schema, input);
  if (result.success) return { ok: true as const, input: result.output };

  return {
    ok: false as const,
    result: failResult(action, 'Invalid action input.', {
      errors: [v.summarize(result.issues)],
    }),
  };
}

function okResult(
  action: string,
  changed: boolean,
  outcome: WatchOutcome | undefined,
  message: string,
  data: { watch?: PrWatch; watches?: PrWatch[] } = {},
): WatchActionResult {
  return {
    ok: true,
    action,
    changed,
    ...(outcome ? { outcome } : {}),
    message,
    ...(data.watch ? { watch: asJsonValue(data.watch) } : {}),
    ...(data.watches ? { watches: data.watches.map(asJsonValue) } : {}),
  };
}

function failResult(
  action: string,
  message: string,
  details: Pick<WatchActionResult, 'errors' | 'requires'> = {},
): WatchActionResult {
  return {
    ok: false,
    action,
    changed: false,
    message,
    ...(details.errors ? { errors: details.errors } : {}),
    ...(details.requires ? { requires: details.requires } : {}),
  };
}

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
