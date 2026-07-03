import { DatabaseSync } from 'node:sqlite';
import { upsertJob } from '../../app-state';
import type { RuntimePaths } from '../../runtime-home';
import type {
  DesiredTerminalState,
  PrWatch,
  PrWatchSnapshot,
  PrWatchStatus,
  RefWatch,
  RefWatchSnapshot,
  RefWatchStatus,
  WatchOutcome,
} from './schemas';

export function insertWatch(paths: RuntimePaths, watch: PrWatch) {
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

export function updateWatch(paths: RuntimePaths, watch: PrWatch) {
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

export function insertRefWatch(paths: RuntimePaths, watch: RefWatch) {
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        INSERT INTO ref_watches (
          id,
          repo_id,
          repo_full_name,
          github_owner,
          github_name,
          ref,
          status,
          title,
          url,
          last_snapshot_json,
          last_outcome,
          last_checked_at,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      )
      .run(...refWatchParams(watch));
  } finally {
    database.close();
  }
}

export function updateRefWatch(paths: RuntimePaths, watch: RefWatch) {
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        UPDATE ref_watches
        SET
          repo_id = ?,
          repo_full_name = ?,
          github_owner = ?,
          github_name = ?,
          ref = ?,
          status = ?,
          title = ?,
          url = ?,
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
        watch.ref,
        watch.status,
        watch.title,
        watch.url,
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

export function upsertWatchPollingJob(
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

export function upsertRefWatchPollingJob(
  watch: RefWatch,
  paths: RuntimePaths,
  intervalSeconds = 300,
) {
  return upsertJob(
    {
      id: refWatchPollingJobId(watch.id),
      type: 'watch-ref',
      blueprint: 'watch-ref',
      enabled: true,
      intervalSeconds,
      config: {
        id: watch.id,
        repo: watch.repoFullName,
        ref: watch.ref,
      },
    },
    paths,
  );
}

export function watchPollingJobId(id: string) {
  return `watch:${id}`;
}

export function refWatchPollingJobId(id: string) {
  return `watch-ref:${id}`;
}

export function upsertReleasePollingJob(watch: PrWatch, paths: RuntimePaths) {
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

export function releasePollingJobId(repoId: string) {
  return `release:${repoId}`;
}

export function readWatches(paths: RuntimePaths): PrWatch[] {
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

export function readWatch(paths: RuntimePaths, id: string) {
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

export function readRefWatches(paths: RuntimePaths): RefWatch[] {
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    return database
      .prepare(
        `
        SELECT *
        FROM ref_watches
        ORDER BY updated_at DESC, created_at DESC;
      `,
      )
      .all()
      .map(readRefWatchRow);
  } finally {
    database.close();
  }
}

export function readRefWatch(paths: RuntimePaths, id: string) {
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    const row = database
      .prepare(
        `
        SELECT *
        FROM ref_watches
        WHERE id = ?;
      `,
      )
      .get(id);

    return row ? readRefWatchRow(row) : undefined;
  } finally {
    database.close();
  }
}

export function deleteWatch(paths: RuntimePaths, id: string) {
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare('DELETE FROM pr_watch_event_watermarks WHERE watch_id = ?;')
      .run(id);
    database.prepare('DELETE FROM pr_watches WHERE id = ?;').run(id);
  } finally {
    database.close();
  }
}

export function refWatchParams(watch: RefWatch) {
  return [
    watch.id,
    watch.repoId,
    watch.repoFullName,
    watch.githubOwner,
    watch.githubName,
    watch.ref,
    watch.status,
    watch.title,
    watch.url,
    watch.lastSnapshot ? JSON.stringify(watch.lastSnapshot) : null,
    watch.lastOutcome,
    watch.lastCheckedAt,
    watch.createdAt,
    watch.updatedAt,
  ];
}

export function watchParams(watch: PrWatch) {
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

export function readRefWatchRow(row: unknown): RefWatch {
  const record = row as Record<string, unknown>;
  const snapshot =
    typeof record.last_snapshot_json === 'string'
      ? (JSON.parse(record.last_snapshot_json) as RefWatchSnapshot)
      : null;

  return {
    id: String(record.id),
    repoId: String(record.repo_id),
    repoFullName: String(record.repo_full_name),
    githubOwner: String(record.github_owner),
    githubName: String(record.github_name),
    ref: String(record.ref),
    status: String(record.status) as RefWatchStatus,
    title: typeof record.title === 'string' ? String(record.title) : null,
    url: typeof record.url === 'string' ? String(record.url) : null,
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

export function readWatchRow(row: unknown): PrWatch {
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
