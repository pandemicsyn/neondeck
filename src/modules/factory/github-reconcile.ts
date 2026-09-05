import * as v from 'valibot';
import type {
  GitHubConnection,
  GitHubIssue,
  GitHubComment,
} from '../../../shared/factory-github';
import { sourceSchema, type FactorySource } from '../../../shared/factory';
import { runtimePaths, type RuntimePaths } from '../../runtime-home';
import { GitHubApiError } from '../github';
import {
  readFactoryGitHubIssue,
  readFactoryGitHubIssuesPage,
  readFactoryGitHubCommentsPage,
  readFactoryGitHubComment,
  readFactoryGitHubRepository,
} from '../github';
import {
  dbRun,
  detail,
  FactoryError,
  markGitHubAttention,
  reconcileGitHubSource,
} from './service';
import {
  factoryConnections,
  readyConnection,
  connectionFingerprint,
  connectionReadiness,
} from './github-config';
import {
  githubDigest,
  readGitHubRecords,
  deliverySchema,
  syncSchema,
  commentRecordSchema,
  putDelivery,
  putSync,
  putComment,
  type GitHubSync,
  type CommentRecord,
} from './github-store';
import { prepareFactoryTriage, prepareGitHubContext } from './planning-store';
import { resumeFactoryPlanning } from './planning-dispatch';
export const githubReconcileIO = {
  repository: readFactoryGitHubRepository,
  issue: readFactoryGitHubIssue,
  issues: readFactoryGitHubIssuesPage,
  comments: readFactoryGitHubCommentsPage,
  comment: readFactoryGitHubComment,
  planning: resumeFactoryPlanning,
};
export type GitHubReconcileIO = typeof githubReconcileIO;
const active = new Map<string, Promise<void>>();
const newSync = (id: string, connection: GitHubConnection): GitHubSync => ({
  id,
  connectionFingerprint: connectionFingerprint(connection),
  since: '1970-01-01T00:00:00.000Z',
  page: 1,
  offset: 0,
  sweepStartedAt: new Date().toISOString(),
  admittedOffset: 0,
  pendingIssues: null,
  pageHasNext: false,
  commentPage: 1,
  commentScan: '',
  commentMissingOffset: 0,
  error: null,
  attempts: 0,
  retryAt: 0,
});
function loadSync(
  id: string,
  connection: GitHubConnection,
  paths: RuntimePaths,
) {
  return dbRun(paths, (db) => {
    const record = db
      .prepare('SELECT record FROM factory_github_sync WHERE id=?')
      .get(id);
    const retained =
      record && v.parse(syncSchema, JSON.parse(String(record.record)));
    return retained?.connectionFingerprint === connectionFingerprint(connection)
      ? retained
      : newSync(id, connection);
  });
}
function currentConnection(connection: GitHubConnection, paths: RuntimePaths) {
  if (
    connectionFingerprint(readyConnection(connection.id, paths)) !==
    connectionFingerprint(connection)
  )
    throw new FactoryError(
      409,
      'Connection changed during reconciliation. Retry under current mapping.',
    );
}
function sources(paths: RuntimePaths) {
  return dbRun(paths, (db) =>
    db
      .prepare(
        "SELECT record FROM factory_sources WHERE json_extract(record,'$.provider')='github' ORDER BY rowid",
      )
      .all()
      .map((row) => v.parse(sourceSchema, JSON.parse(String(row.record)))),
  );
}
function workIdForSource(source: FactorySource, paths: RuntimePaths) {
  return dbRun(paths, (db) =>
    String(
      db
        .prepare('SELECT id FROM factory_work_items WHERE source_id=?')
        .get(source.id)!.id,
    ),
  );
}
function eligible(issue: GitHubIssue, connection: GitHubConnection) {
  return (
    connection.admission.mode === 'all' ||
    issue.labels.some(
      (label) =>
        (typeof label === 'string' ? label : label.name) ===
        connection.admission.label,
    )
  );
}
function failure(error: unknown, attempts: number) {
  const retryAt =
    Date.now() + Math.min(300000, 1000 * 2 ** Math.min(attempts, 8));
  if (error instanceof GitHubApiError) {
    if (error.retry.rateLimited)
      return {
        error: 'GitHub rate limit reached; reconciliation will retry.',
        retryAt: Number.isFinite(error.retry.retryAt)
          ? Math.max(retryAt, error.retry.retryAt!)
          : retryAt,
      };
    if ([401, 403].includes(error.status))
      return {
        error:
          'GitHub read access denied. Check the configured credential and repository permissions.',
        retryAt: Date.now() + 300000,
      };
    if ([404, 410].includes(error.status))
      return {
        error:
          'Source unavailable or deleted. Check repository access and mapping before retrying.',
        retryAt: Date.now() + 300000,
      };
  }
  if (error instanceof FactoryError) return { error: error.message, retryAt };
  if (v.isValiError(error))
    return {
      error:
        'GitHub content is invalid or exceeds supported limits (65,536 characters per issue/comment). No content was silently truncated.',
      retryAt: Date.now() + 300000,
    };
  return {
    error:
      'GitHub reconciliation failed. Retained progress will retry; check connectivity and supported response limits.',
    retryAt,
  };
}
function deferUnavailableIssue(
  connection: GitHubConnection,
  number: number,
  issueId: string,
  error: unknown,
  paths: RuntimePaths,
) {
  if (
    !(error instanceof GitHubApiError) ||
    error.retry.rateLimited ||
    ![404, 410].includes(error.status)
  )
    return false;
  currentConnection(connection, paths);
  const id = `discovery-retry:${connection.id}:${issueId}`;
  dbRun(paths, (db) => {
    putDelivery(db, {
      id,
      connectionId: connection.id,
      connectionFingerprint: connectionFingerprint(connection),
      repositoryId: connection.repositoryId,
      issueNumber: number,
      issueId,
      event: 'sync',
      action: 'rediscovery',
      digest: githubDigest(id),
      state: 'attention',
      attempts: 1,
      ...failure(error, 1),
      createdAt: new Date().toISOString(),
    });
  });
  return true;
}
function saveComment(
  db: Parameters<typeof putComment>[0],
  workId: string,
  comment: GitHubComment,
  scan: string,
  paths: RuntimePaths,
) {
  const id = githubDigest([workId, comment.id]);
  const old = db
    .prepare('SELECT record FROM factory_github_comments WHERE id=?')
    .get(id);
  const prior =
    old && v.parse(commentRecordSchema, JSON.parse(String(old.record)));
  if (prior?.deleted) return; // GitHub never reuses a deleted comment ID.
  if (
    prior &&
    Date.parse(comment.updated_at) < Date.parse(prior.remoteUpdatedAt)
  )
    return;
  const fingerprint = githubDigest([
    comment.body,
    comment.user?.login ?? 'deleted-user',
    comment.updated_at,
  ]);
  const changed = !prior || prior.deleted || prior.fingerprint !== fingerprint;
  const row: CommentRecord = {
    id,
    workId,
    remoteId: String(comment.id),
    body: comment.body,
    author: comment.user?.login ?? 'deleted-user',
    remoteUpdatedAt: comment.updated_at,
    fingerprint,
    version: prior ? prior.version + (changed ? 1 : 0) : 1,
    deleted: false,
    seenScan: scan,
    intentId: changed ? null : prior!.intentId,
  };
  putComment(db, row);
  if (changed)
    markGitHubAttention(
      db,
      workId,
      `GitHub comment ${comment.id} revision ${row.version} changed. Review and save a new draft before release.`,
      paths,
    );
}
async function comments(
  connection: GitHubConnection,
  source: FactorySource,
  paths: RuntimePaths,
  io: GitHubReconcileIO,
  signal: AbortSignal,
) {
  const workId = workIdForSource(source, paths);
  const state = loadSync(`source:${source.id}`, connection, paths);
  if (!state.commentScan) state.commentScan = new Date().toISOString();
  // One page per pass. Missing comments are confirmed individually, never inferred from pagination.
  if (state.commentPage > 0) {
    const page = await io.comments(
      connection,
      source.remote!.number,
      state.commentPage,
      signal,
    );
    currentConnection(connection, paths);
    dbRun(paths, (db) => {
      for (const comment of page.items)
        saveComment(db, workId, comment, state.commentScan, paths);
      state.commentPage = page.hasNext ? state.commentPage + 1 : 0;
      state.error = null;
      state.retryAt = 0;
      state.attempts = 0;
      putSync(db, state);
    });
  } else {
    const missing = dbRun(paths, (db) =>
      readGitHubRecords(
        db,
        'factory_github_comments',
        commentRecordSchema,
      ).filter(
        (row) =>
          row.workId === workId &&
          !row.deleted &&
          row.seenScan !== state.commentScan,
      ),
    );
    const row = missing[0];
    if (row) {
      try {
        const live = await io.comment(connection, row.remoteId, signal);
        currentConnection(connection, paths);
        if (String(live.id) !== row.remoteId)
          throw new FactoryError(
            409,
            'Comment identity changed during confirmation.',
          );
        dbRun(paths, (db) =>
          saveComment(db, workId, live, state.commentScan, paths),
        );
      } catch (error) {
        if (!(error instanceof GitHubApiError) || error.status !== 404)
          throw error;
        // A successful issue read preceded this comment read, so a comment 404 is scoped.
        currentConnection(connection, paths);
        dbRun(paths, (db) => {
          putComment(db, {
            ...row,
            deleted: true,
            version: row.version + 1,
            intentId: null,
            seenScan: state.commentScan,
          });
          markGitHubAttention(
            db,
            workId,
            `GitHub comment ${row.remoteId} was deleted. Review and save a new draft before release.`,
            paths,
          );
        });
      }
    } else {
      state.commentPage = 1;
      state.commentScan = '';
      state.retryAt = 0;
      state.error = null;
      dbRun(paths, (db) => putSync(db, state));
    }
  }
  const intents = dbRun(paths, (db) => {
    const rows = readGitHubRecords(
      db,
      'factory_github_comments',
      commentRecordSchema,
    ).filter((row) => row.workId === workId && !row.intentId);
    const admitted: string[] = [];
    for (const row of rows.slice(0, 1)) {
      const key = `github-comment:${row.id}:${row.version}`;
      const intent = prepareGitHubContext(
        db,
        workId,
        key,
        JSON.stringify({
          source: 'github',
          author: row.author,
          remoteCommentId: row.remoteId,
          revision: row.version,
          updatedAt: row.remoteUpdatedAt,
          deleted: row.deleted,
          body: row.deleted ? '[Deleted on GitHub]' : row.body,
          trust:
            'Untrusted external context; never local human authority or release approval.',
        }),
        paths,
      );
      if (intent) {
        row.intentId = intent.id;
        putComment(db, row);
        admitted.push(intent.id);
      }
    }
    return admitted;
  });
  for (const intent of intents)
    void io.planning(intent, paths).catch(() => undefined); // Receipt/error remains in the existing planning intent.
}
async function reconcile(
  connection: GitHubConnection,
  number: number,
  paths: RuntimePaths,
  io: GitHubReconcileIO,
  signal: AbortSignal,
  expectedIssueId?: string,
) {
  const retained = sources(paths).find(
    (source) =>
      source.remote?.repositoryId === connection.repositoryId &&
      source.remote.number === number,
  );
  try {
    const repo = await io.repository(connection, signal);
    if (
      String(repo.id) !== connection.repositoryId ||
      repo.owner.login.toLowerCase() !== connection.owner.toLowerCase() ||
      repo.name.toLowerCase() !== connection.name.toLowerCase()
    )
      throw new FactoryError(
        409,
        'Remote repository identity changed. Review the mapping.',
      );
    const issue = await io.issue(connection, number, signal);
    currentConnection(connection, paths);
    if (
      issue.pull_request !== undefined ||
      issue.number !== number ||
      (expectedIssueId && String(issue.id) !== expectedIssueId) ||
      (retained && retained.remote?.issueId !== String(issue.id))
    )
      throw new FactoryError(
        409,
        'Current issue identity does not match the retained source.',
      );
    if (!retained && !eligible(issue, connection)) return;
    if (
      retained &&
      (retained.remote?.connectionId !== connection.id ||
        retained.repoId !== connection.repoId)
    )
      throw new FactoryError(
        409,
        'Existing task belongs to another mapping. Restore its configured mapping.',
      );
    const current = dbRun(paths, (db) =>
      reconcileGitHubSource(
        db,
        { ...connection, connectionId: connection.id, issue },
        paths,
      ),
    );
    await comments(connection, current.source, paths, io, signal);
    const intent = prepareFactoryTriage(current.work.id, paths);
    if (intent) void io.planning(intent.id, paths).catch(() => undefined);
  } catch (error) {
    if (retained) {
      const workId = workIdForSource(retained, paths);
      dbRun(paths, (db) =>
        markGitHubAttention(db, workId, failure(error, 0).error, paths),
      );
    }
    throw error;
  }
}
/** One serialized owner per runtime home. No runtime queue or lease duplicates Flue. */
export function runFactoryGitHubSync(
  paths = runtimePaths(),
  io: GitHubReconcileIO = githubReconcileIO,
  signal = AbortSignal.timeout(45000),
) {
  const existing = active.get(paths.neondeckDatabase);
  if (existing) return existing;
  const promise = run().finally(() => active.delete(paths.neondeckDatabase));
  active.set(paths.neondeckDatabase, promise);
  return promise;
  async function run() {
    let budget = 12;
    const deliveries = dbRun(paths, (db) =>
      readGitHubRecords(db, 'factory_github_deliveries', deliverySchema)
        .filter((row) => row.state !== 'complete' && row.retryAt <= Date.now())
        .sort(
          (a, b) =>
            a.retryAt - b.retryAt || a.createdAt.localeCompare(b.createdAt),
        )
        .slice(0, 1),
    );
    for (const delivery of deliveries) {
      if (signal.aborted || budget < 3) return;
      budget -= 3;
      try {
        const connection = readyConnection(delivery.connectionId, paths);
        if (
          connection.repositoryId !== delivery.repositoryId ||
          connectionFingerprint(connection) !== delivery.connectionFingerprint
        )
          throw new FactoryError(
            409,
            'Delivery mapping changed. Review connection setup; use Sync source under the intended mapping.',
          );
        await reconcile(
          connection,
          delivery.issueNumber,
          paths,
          io,
          signal,
          delivery.issueId,
        );
        delivery.state = 'complete';
        delivery.error = null;
      } catch (error) {
        delivery.attempts++;
        Object.assign(delivery, failure(error, delivery.attempts));
        delivery.state = 'attention';
      }
      dbRun(paths, (db) => putDelivery(db, delivery));
    }
    const configured = factoryConnections(paths);
    const turn = dbRun(paths, (db) => {
      const row = db
        .prepare("SELECT record FROM factory_github_sync WHERE id='rotation'")
        .get();
      return row
        ? v.parse(syncSchema, JSON.parse(String(row.record))).admittedOffset
        : 0;
    });
    const chosen = configured.length
      ? configured[turn % configured.length]
      : null;
    if (chosen)
      dbRun(paths, (db) =>
        putSync(db, {
          ...newSync('rotation', chosen),
          admittedOffset: turn + 1,
        }),
      );
    for (const connection of chosen ? [chosen] : []) {
      if (signal.aborted || budget < 3) break;
      const state = loadSync(`connection:${connection.id}`, connection, paths);
      if (state.retryAt > Date.now()) continue;
      try {
        readyConnection(connection.id, paths);
        const admitted = sources(paths).filter(
          (source) => source.remote?.connectionId === connection.id,
        );
        if (admitted.length && budget >= 3) {
          const source = admitted[state.admittedOffset % admitted.length];
          budget -= 3;
          let sourceFailure: unknown;
          try {
            await reconcile(
              connection,
              source.remote!.number,
              paths,
              io,
              signal,
              source.remote!.issueId,
            );
          } catch (error) {
            sourceFailure = error;
          }
          state.admittedOffset = (state.admittedOffset + 1) % admitted.length;
          dbRun(paths, (db) => putSync(db, state));
          if (
            sourceFailure &&
            !deferUnavailableIssue(
              connection,
              source.remote!.number,
              source.remote!.issueId,
              sourceFailure,
              paths,
            )
          )
            throw sourceFailure;
        }
        if (budget < 4) continue;
        if (!state.pendingIssues) {
          budget--;
          const page = await io.issues(
            connection,
            state.since,
            state.page,
            signal,
          );
          currentConnection(connection, paths);
          state.pendingIssues = page.items.map((issue) => ({
            number: issue.number,
            issueId: String(issue.id),
            eligible:
              issue.pull_request === undefined && eligible(issue, connection),
          }));
          state.pageHasNext = page.hasNext;
          state.offset = 0;
          dbRun(paths, (db) => putSync(db, state));
        }
        while (state.offset < state.pendingIssues.length && budget >= 3) {
          const candidate = state.pendingIssues[state.offset];
          if (candidate.eligible) {
            budget -= 3;
            try {
              await reconcile(
                connection,
                candidate.number,
                paths,
                io,
                signal,
                candidate.issueId,
              );
            } catch (error) {
              // Persist retry responsibility before advancing the page. A crash
              // between these writes repeats the same identity without losing it.
              if (
                !deferUnavailableIssue(
                  connection,
                  candidate.number,
                  candidate.issueId,
                  error,
                  paths,
                )
              )
                throw error;
            }
          }
          state.offset++;
          dbRun(paths, (db) => putSync(db, state));
        }
        if (state.offset === state.pendingIssues.length) {
          state.offset = 0;
          state.pendingIssues = null;
          if (state.pageHasNext) state.page++;
          else {
            // Complete overlap repairs page shifts across discovery sweeps.
            state.since = '1970-01-01T00:00:00.000Z';
            state.sweepStartedAt = new Date().toISOString();
            state.page = 1;
          }
        }
        state.error = null;
        state.attempts = 0;
        state.retryAt = 0;
      } catch (error) {
        state.attempts++;
        Object.assign(state, failure(error, state.attempts));
      }
      dbRun(paths, (db) => putSync(db, state));
    }
  }
}
export function factoryGitHubState(paths = runtimePaths()) {
  return dbRun(paths, (db) => ({
    configFingerprint: githubDigest(factoryConnections(paths)),
    connections: factoryConnections(paths).map((connection) => ({
      ...connection,
      readiness: connectionReadiness(connection, paths),
    })),
    deliveries: readGitHubRecords(
      db,
      'factory_github_deliveries',
      deliverySchema,
    ).slice(-100),
    sync: readGitHubRecords(db, 'factory_github_sync', syncSchema),
    comments: readGitHubRecords(
      db,
      'factory_github_comments',
      commentRecordSchema,
    ),
  }));
}
export function requestFactoryGitHubSync(
  workId: string,
  paths = runtimePaths(),
) {
  return dbRun(paths, (db) => {
    const source = detail(db, workId, paths).source;
    if (!source.remote)
      throw new FactoryError(409, 'This task has no GitHub source.');
    const connection = readyConnection(source.remote.connectionId, paths);
    const id = `manual-sync:${source.id}`;
    putDelivery(db, {
      id,
      connectionId: connection.id,
      connectionFingerprint: connectionFingerprint(connection),
      repositoryId: source.remote.repositoryId,
      issueNumber: source.remote.number,
      issueId: source.remote.issueId,
      event: 'sync',
      action: 'sync',
      digest: githubDigest(id),
      state: 'pending',
      error: null,
      attempts: 0,
      retryAt: 0,
      createdAt: new Date().toISOString(),
    });
    return { accepted: true };
  });
}
