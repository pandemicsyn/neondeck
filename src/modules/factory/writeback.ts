import * as v from 'valibot';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { GitHubComment } from '../../../shared/factory-github';
import type { WritebackEffect } from '../../../shared/factory-writeback';
import { runtimePaths, type RuntimePaths } from '../../runtime-home';
import * as github from '../github';
import { GitHubApiError } from '../github';
import { dbRun, detail, FactoryError, type FactoryActor } from './service';
import {
  rows,
  put,
  context,
  queueStatus,
  effectAuthorized,
  stateInDb,
  makeEffect,
} from './writeback-store';
import { connectionFingerprint, factoryConnections } from './github-config';
import {
  commentRecordSchema,
  readGitHubRecords,
  putComment,
} from './github-store';
export const writebackIO = {
  repository: github.readFactoryGitHubRepository,
  issue: github.readFactoryGitHubIssue,
  comments: github.readFactoryGitHubCommentsPage,
  comment: github.readFactoryGitHubComment,
  identity: github.factoryGitHubIdentity,
  create: github.createFactoryGitHubComment,
  update: github.updateFactoryGitHubComment,
};
export type WritebackIO = typeof writebackIO;
const active = new Map<string, Promise<void>>();
function exact(e: WritebackEffect, comment: GitHubComment) {
  return (
    comment.body === e.body &&
    comment.user?.login === e.author &&
    comment.user?.id === e.authorId &&
    (!e.remoteId || String(comment.id) === e.remoteId)
  );
}
export function echoDisposition(
  db: DatabaseSync,
  workId: string,
  comment: {
    id: number | string;
    body: string;
    user: { login: string; id?: number } | null;
    updated_at: string;
  },
) {
  const effects = rows(db, 'effect').filter((e) => e.workId === workId);
  if (
    effects.some(
      (e) =>
        e.state === 'sent' &&
        e.remoteId === String(comment.id) &&
        e.confirmedBody === comment.body &&
        e.author === comment.user?.login &&
        e.authorId === comment.user?.id &&
        e.confirmedUpdatedAt === comment.updated_at,
    )
  )
    return 'confirmed' as const;
  // Hold a matching in-flight candidate, not a receipt. Never suppress merely by marker or author.
  if (
    effects.some(
      (e) =>
        ['sending', 'uncertain'].includes(e.state) &&
        e.body === comment.body &&
        e.author === comment.user?.login &&
        e.authorId === comment.user?.id &&
        (!e.remoteId || e.remoteId === String(comment.id)),
    )
  )
    return 'awaiting-receipt' as const;
  return 'external' as const;
}
function receipt(
  e: WritebackEffect,
  comment: GitHubComment,
  paths: RuntimePaths,
) {
  if (!exact(e, comment))
    throw new Error('GitHub receipt does not match the authorized effect.');
  dbRun(paths, (db) => {
    const settled: WritebackEffect = {
      ...e,
      state: 'sent',
      remoteId: String(comment.id),
      confirmedBody: comment.body,
      confirmedUpdatedAt: comment.updated_at,
      error: null,
      retryAt: 0,
    };
    put(db, 'effect', settled);
    if (e.kind === 'status') {
      const s = rows(db, 'status').find((s) => s.workId === e.workId)!;
      put(db, 'status', {
        ...s,
        marker: e.marker,
        repairRequired: false,
        remoteId: settled.remoteId,
        author: e.author,
        authorId: e.authorId,
        confirmedBody: comment.body,
        confirmedUpdatedAt: comment.updated_at,
      });
    }
    // Receipt may arrive after ingress stored the comment. Confirm only the exact retained revision.
    for (const row of readGitHubRecords(
      db,
      'factory_github_comments',
      commentRecordSchema,
    ).filter(
      (r) =>
        r.workId === e.workId &&
        r.remoteId === String(comment.id) &&
        !r.deleted &&
        r.body === comment.body &&
        r.author === e.author &&
        r.authorId === e.authorId &&
        r.remoteUpdatedAt === comment.updated_at,
    ))
      putComment(db, { ...row, echo: 'confirmed' });
  });
}
function save(e: WritebackEffect, paths: RuntimePaths) {
  dbRun(paths, (db) => put(db, 'effect', e));
}
function errorMessage(error: unknown) {
  if (error instanceof GitHubApiError) {
    if (error.retry.rateLimited)
      return 'GitHub rate limit reached. Retry after the indicated time.';
    if ([401, 403].includes(error.status))
      return 'GitHub write access denied. Check the credential reference and Issues write permission.';
  }
  return error instanceof FactoryError
    ? error.message
    : 'GitHub request failed. Inspect sync state before retrying.';
}
/** One bounded continuation, invoked by the existing single runtime recovery loop. */
export function runFactoryWriteback(
  paths = runtimePaths(),
  io: WritebackIO = writebackIO,
  signal = AbortSignal.timeout(45000),
) {
  const prior = active.get(paths.neondeckDatabase);
  if (prior) return prior;
  const pending = run().finally(() => active.delete(paths.neondeckDatabase));
  active.set(paths.neondeckDatabase, pending);
  return pending;
  async function run() {
    dbRun(paths, (db) => {
      for (const row of db
        .prepare('SELECT id FROM factory_work_items ORDER BY rowid')
        .all()) {
        try {
          if (detail(db, String(row.id), paths).source.remote)
            queueStatus(db, String(row.id), paths);
        } catch (error) {
          if (!(error instanceof FactoryError)) throw error;
        }
      }
    });
    const candidates = dbRun(paths, (db) =>
      rows(db, 'effect').filter(
        (e) =>
          ['pending', 'sending', 'uncertain'].includes(e.state) &&
          e.retryAt <= Date.now(),
      ),
    );
    // Oldest due first; each effect yields after this finite operation to avoid starving siblings.
    const e = candidates.sort(
      (a, b) => a.retryAt - b.retryAt || a.createdAt.localeCompare(b.createdAt),
    )[0];
    if (!e || signal.aborted) return;
    let dispatched = ['sending', 'uncertain'].includes(e.state);
    let writeInvoked = false;
    try {
      // Recovery is read-only even after opt-out; never discard evidence of a dispatched request.
      const connection = factoryConnections(paths).find(
        (c) => c.id === e.connectionId,
      );
      if (
        !connection ||
        connectionFingerprint(connection) !== e.connectionFingerprint
      )
        throw new FactoryError(
          409,
          'Mapping changed. Restore the original connection to reconcile this effect.',
        );
      if (!dispatched) dbRun(paths, (db) => effectAuthorized(db, e, paths));
      const repo = await io.repository(connection, signal);
      const source = await io.issue(connection, e.number, signal);
      if (
        String(repo.id) !== connection.repositoryId ||
        repo.owner.login.toLowerCase() !== connection.owner.toLowerCase() ||
        repo.name.toLowerCase() !== connection.name.toLowerCase() ||
        String(source.id) !== e.issueId ||
        source.number !== e.number ||
        source.pull_request !== undefined
      )
        throw new FactoryError(
          409,
          'Remote target identity changed. No comment was written.',
        );
      if (dispatched) {
        if (e.remoteId) {
          const live = await io.comment(connection, e.remoteId, signal);
          if (exact(e, live)) receipt(e, live, paths);
          else {
            e.state = 'repair';
            e.error =
              'Remote comment differs from the dispatched content. Explicit repair or relinquish required.';
            save(e, paths);
          }
        } else {
          // A complete bounded scan can prove a matching receipt, never prove that a timed-out POST did not commit.
          const matches = new Set(e.scanMatches);
          let complete = false;
          for (let step = 0; step < 4 && !signal.aborted; step++) {
            const result = await io.comments(
              connection,
              e.number,
              e.scanPage,
              signal,
            );
            for (const c of result.items.filter((c) => exact(e, c)))
              if (matches.size < 2) matches.add(String(c.id));
            e.scanMatches = [...matches];
            e.scanPage++;
            save(e, paths);
            if (!result.hasNext) {
              complete = true;
              break;
            }
          }
          if (complete && matches.size === 1) {
            const live = await io.comment(connection, [...matches][0], signal);
            if (!exact(e, live)) throw new Error('Remote candidate changed.');
            receipt(e, live, paths);
          } else {
            e.state = 'uncertain';
            e.retryAt = Date.now() + 300000;
            e.error = complete
              ? 'No unique confirmed receipt. No duplicate will be created. Recheck or relinquish.'
              : 'Comment scan is incomplete. Durable pagination continues on the next check; no duplicate will be created.';
            if (complete) {
              e.scanPage = 1;
              e.scanMatches = [];
            }
            save(e, paths);
          }
        }
        return;
      }
      // Latest provider source content must match admission before issuing a new write.
      const current = dbRun(paths, (db) => context(db, e.workId, paths));
      if (
        source.updated_at !== current.remote.updatedAt ||
        source.state !== current.d.source.status ||
        (source.body ?? '') !== current.d.source.body ||
        source.title !== current.d.source.title
      )
        throw new FactoryError(
          409,
          'GitHub source changed. Sync source and review before sending.',
        );
      const identity = await io.identity(connection, signal);
      if (e.remoteId && e.authorId !== identity.id) {
        e.state = 'repair';
        e.error =
          'Configured credential no longer owns this comment. Restore the original author or relinquish management.';
        save(e, paths);
        return;
      }
      e.author = identity.login;
      e.authorId = identity.id;
      if (e.remoteId) {
        const live = await io.comment(connection, e.remoteId, signal);
        if (
          String(live.id) !== e.remoteId ||
          live.body !== e.confirmedBody ||
          live.updated_at !== e.confirmedUpdatedAt ||
          live.user?.login !== e.author ||
          live.user?.id !== e.authorId
        ) {
          e.state = 'repair';
          e.error =
            'Managed comment was edited remotely. Automatic overwrite stopped.';
          save(e, paths);
          return;
        }
      }
      if (!e.remoteId && e.approvalId) {
        const repair = dbRun(paths, (db) =>
          rows(db, 'repair').find((r) => r.id === e.approvalId),
        );
        if (repair && !repair.observed) {
          const original = dbRun(paths, (db) =>
            rows(db, 'status').find((x) => x.workId === e.workId),
          );
          try {
            if (!original?.remoteId)
              throw new FactoryError(
                409,
                'Managed comment identity is unavailable. Relinquish management.',
              );
            await io.comment(connection, original.remoteId, signal);
            throw new FactoryError(
              409,
              'The missing comment reappeared. Review repair again; no duplicate was created.',
            );
          } catch (error) {
            if (!(error instanceof GitHubApiError) || error.status !== 404)
              throw error;
          }
        }
      }
      signal.throwIfAborted();
      dbRun(paths, (db) => {
        const latest = rows(db, 'effect').find((x) => x.id === e.id)!;
        if (latest.state !== 'pending')
          throw new FactoryError(409, 'Effect was cancelled before dispatch.');
        effectAuthorized(db, e, paths);
        e.state = 'sending';
        e.attempts++;
        e.error = null;
        put(db, 'effect', e);
      });
      dispatched = true;
      // No await between the final authorization fence and invoking the transport.
      writeInvoked = true;
      const response = e.remoteId
        ? await io.update(connection, e.remoteId, e.body, signal)
        : await io.create(connection, e.number, e.body, signal);
      receipt(e, response, paths);
    } catch (error) {
      if (
        !dispatched &&
        dbRun(
          paths,
          (db) => rows(db, 'effect').find((x) => x.id === e.id)?.state,
        ) === 'cancelled'
      )
        return;
      if (
        writeInvoked &&
        error instanceof GitHubApiError &&
        [401, 403, 422, 429].includes(error.status)
      ) {
        e.state = 'failed';
        e.error = errorMessage(error);
      } else if (dispatched) {
        e.state =
          error instanceof GitHubApiError &&
          error.status === 404 &&
          !!e.remoteId
            ? 'repair'
            : 'uncertain';
        e.error = `${errorMessage(error)} Outcome is not assumed; no blind retry.`;
      } else if (
        error instanceof FactoryError &&
        [403, 409].includes(error.status)
      ) {
        e.state = e.kind === 'status' && e.approvalId ? 'repair' : 'cancelled';
        e.error = error.message;
      } else {
        e.state =
          error instanceof GitHubApiError &&
          error.status === 404 &&
          !!e.remoteId
            ? 'repair'
            : 'failed';
        e.error =
          e.state === 'repair'
            ? 'Managed comment is unavailable. Explicit repair or relinquish required.'
            : errorMessage(error);
      }
      e.retryAt =
        error instanceof GitHubApiError && error.retry.retryAt
          ? Math.max(Date.now() + 300000, error.retry.retryAt)
          : Date.now() + 300000;
      save(e, paths);
    }
  }
}
export function recoverWriteback(
  workId: string,
  input: unknown,
  actor: FactoryActor,
  paths = runtimePaths(),
) {
  if (actor.kind !== 'human')
    throw new FactoryError(403, 'Human action required.');
  const value = v.parse(
    v.strictObject({
      effectId: v.string(),
      action: v.picklist(['retry', 'relinquish']),
    }),
    input,
  );
  return dbRun(paths, (db) => {
    const e = rows(db, 'effect').find(
      (e) => e.id === value.effectId && e.workId === workId,
    );
    if (!e) throw new FactoryError(404, 'Effect not found.');
    if (e.state === 'sending')
      throw new FactoryError(409, 'Wait for the in-flight request to settle.');
    if (value.action === 'relinquish') {
      if (e.kind === 'status') {
        const status = rows(db, 'status').find((s) => s.workId === workId)!;
        put(db, 'status', { ...status, relinquished: true });
        for (const other of rows(db, 'effect').filter(
          (x) =>
            x.workId === workId && x.kind === 'status' && x.state !== 'sent',
        ))
          put(db, 'effect', {
            ...other,
            state: 'cancelled',
            error: 'Human relinquished management; retained audit only.',
          });
      } else
        put(db, 'effect', {
          ...e,
          state: 'cancelled',
          error: 'Human relinquished reconciliation; delivery remains unknown.',
        });
    } else {
      if (!['uncertain', 'failed'].includes(e.state))
        throw new FactoryError(
          409,
          'This effect requires explicit relinquishment or repair.',
        );
      if (e.state === 'failed') {
        effectAuthorized(db, e, paths);
        e.state = 'pending';
      }
      e.retryAt = 0;
      put(db, 'effect', e);
    }
    return stateInDb(db, workId, paths);
  });
}

/** Read a concrete repair preview. A 404 alone is not proof: first validate the accessible issue. */
export async function previewWritebackRepair(
  workId: string,
  effectId: string,
  paths = runtimePaths(),
  io: WritebackIO = writebackIO,
) {
  const signal = AbortSignal.timeout(30000);
  const bound = dbRun(paths, (db) => {
    const ctx = context(db, workId, paths);
    const e = rows(db, 'effect').find(
      (e) => e.id === effectId && e.workId === workId,
    );
    const managed = rows(db, 'status').find((s) => s.workId === workId);
    if (
      !e ||
      e.kind !== 'status' ||
      e.state !== 'repair' ||
      !managed?.remoteId ||
      managed.relinquished
    )
      throw new FactoryError(
        409,
        'Only a known managed status comment can be repaired.',
      );
    return { ...ctx, e, managed };
  });
  const issue = await io.issue(bound.connection, bound.remote.number, signal);
  if (
    String(issue.id) !== bound.remote.issueId ||
    issue.pull_request !== undefined
  )
    throw new FactoryError(409, 'Issue identity changed.');
  let observed = null;
  try {
    const c = await io.comment(
      bound.connection,
      bound.managed.remoteId!,
      signal,
    );
    if (
      String(c.id) !== bound.managed.remoteId ||
      c.user?.login !== bound.managed.author ||
      c.user?.id !== bound.managed.authorId
    )
      throw new FactoryError(
        409,
        'Comment ownership changed. Relinquish management.',
      );
    observed = {
      id: String(c.id),
      body: c.body,
      author: c.user.login,
      updatedAt: c.updated_at,
    };
  } catch (error) {
    if (!(error instanceof GitHubApiError) || error.status !== 404) throw error;
  }
  return dbRun(paths, (db) => {
    const current = context(db, workId, paths);
    if (
      current.p.epoch !== bound.p.epoch ||
      current.d.work.version !== bound.d.work.version
    )
      throw new FactoryError(
        409,
        'Task or policy changed while loading preview.',
      );
    const preview = {
      approvedBy: null,
      approvedAt: null,
      id: randomUUID(),
      workId,
      effectId,
      epoch: current.p.epoch,
      workVersion: current.d.work.version,
      observed,
      replacement: stateInDb(db, workId, paths).template,
      expiresAt: Date.now() + 300000,
    };
    put(db, 'repair', preview);
    return preview;
  });
}
export function approveWritebackRepair(
  workId: string,
  input: unknown,
  actor: FactoryActor,
  paths = runtimePaths(),
) {
  if (actor.kind !== 'human')
    throw new FactoryError(403, 'Human approval required.');
  const value = v.parse(
    v.strictObject({ previewId: v.string(), replacement: v.string() }),
    input,
  );
  return dbRun(paths, (db) => {
    const preview = rows(db, 'repair').find(
      (r) => r.id === value.previewId && r.workId === workId,
    );
    const current = context(db, workId, paths);
    if (
      !preview ||
      preview.expiresAt < Date.now() ||
      preview.epoch !== current.p.epoch ||
      preview.workVersion !== current.d.work.version ||
      preview.replacement !== value.replacement ||
      stateInDb(db, workId, paths).template !== value.replacement
    )
      throw new FactoryError(
        409,
        'Repair preview changed or expired. Review again.',
      );
    const e = rows(db, 'effect').find((e) => e.id === preview.effectId)!;
    if (e.state !== 'repair')
      throw new FactoryError(409, 'Repair was already handled.');
    const status = rows(db, 'status').find((s) => s.workId === workId)!;
    if (status.relinquished)
      throw new FactoryError(409, 'Management was relinquished.');
    put(db, 'repair', {
      ...preview,
      approvedBy: actor.id,
      approvedAt: new Date().toISOString(),
    });
    const marker = preview.observed
      ? status.marker
      : `<!-- neon-factory-status:${randomUUID()} -->`;
    put(db, 'effect', {
      ...e,
      state: 'cancelled',
      error: `Repair explicitly approved by ${actor.id}.`,
    });
    const next = makeEffect(
      db,
      workId,
      'status',
      `${preview.replacement}\n\n${marker}`,
      marker,
      preview.id,
      paths,
    );
    next.remoteId = preview.observed?.id ?? null;
    next.author = preview.observed?.author ?? null;
    next.authorId = e.authorId;
    next.confirmedBody = preview.observed?.body ?? null;
    next.confirmedUpdatedAt = preview.observed?.updatedAt ?? null;
    // Observed remote edits are only this repair's precondition. Ownership's
    // confirmed baseline advances exclusively when the approved write has a receipt.
    put(db, 'status', { ...status, repairRequired: true });
    put(db, 'effect', next);
    return stateInDb(db, workId, paths);
  });
}

/** Provider edits are context and a repair signal, never permission to overwrite. */
export function observeOwnedCommentChange(
  db: DatabaseSync,
  workId: string,
  remoteId: string,
) {
  const status = rows(db, 'status').find(
    (s) => s.workId === workId && s.remoteId === remoteId,
  );
  if (!status || status.relinquished) return;
  const effects = rows(db, 'effect').filter(
    (e) => e.workId === workId && e.kind === 'status',
  );
  if (
    effects.some((e) =>
      ['pending', 'sending', 'uncertain', 'repair'].includes(e.state),
    )
  )
    return;
  const receipt = effects
    .filter((e) => e.state === 'sent' && e.remoteId === remoteId)
    .at(-1);
  if (!receipt) return;
  put(db, 'effect', {
    ...receipt,
    id: randomUUID(),
    state: 'repair',
    error:
      'Owned status comment changed or was deleted on GitHub. Review repair or relinquish management.',
    createdAt: new Date().toISOString(),
    retryAt: 0,
  });
}
