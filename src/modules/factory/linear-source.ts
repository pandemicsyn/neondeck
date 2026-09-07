import { clearLinearReadFailure } from './linear-read-health';
import { matchesLinearSourceBinding } from './linear-authority';
import { randomUUID } from 'node:crypto';
import * as v from 'valibot';
import type { DatabaseSync } from 'node:sqlite';
import {
  emptyFactorySpec,
  sourceSchema,
  workSchema,
  type FactoryWork,
} from '../../../shared/factory';
import type {
  LinearConnection,
  LinearIssue,
} from '../../../shared/factory-linear';
import type { RuntimePaths } from '../../runtime-home';
import {
  audit,
  FactoryError,
  detail,
  insertRevision,
  putWork,
  repoSnapshot,
  withdraw,
} from './service';
import {
  linearEligible,
  linearFingerprint,
  linearMappings,
  linearConnections,
} from './linear-config';
import { linearRecords, putLinearRecord } from './linear-store';
export const linearContentFingerprint = (issue: LinearIssue) =>
  linearFingerprint({
    title: issue.title,
    body: issue.description ?? '',
    team: issue.team.id,
    project: issue.project?.id ?? null,
    labels: issue.labels.map((l) => l.id).sort(),
    archived: issue.archivedAt,
  });
export function reconcileLinearSource(
  db: DatabaseSync,
  c: LinearConnection,
  issue: LinearIssue | null,
  issueId: string,
  paths: RuntimePaths,
  removedAt?: string,
) {
  if (issue && issue.id !== issueId)
    throw new FactoryError(409, 'Linear issue identity mismatch.');
  const key = `linear:${c.organizationId}:${issueId}`;
  const row = db
    .prepare('SELECT record FROM factory_sources WHERE request_key=?')
    .get(key);
  const previous = row
    ? v.parse(sourceSchema, JSON.parse(String(row.record)))
    : null;
  if (
    previous &&
    !issue &&
    removedAt &&
    Date.parse(removedAt) < Date.parse(previous.linear!.updatedAt)
  )
    return null;
  const tombstoneId = `removal:${c.organizationId}:${issueId}`;
  const tombstone = linearRecords(db, 'removal').find(
    (r) => r.id === tombstoneId,
  );
  if (
    !issue &&
    removedAt &&
    (!tombstone || Date.parse(removedAt) > Date.parse(tombstone.createdAt))
  )
    putLinearRecord(db, {
      id: tombstoneId,
      kind: 'removal',
      connectionId: c.id,
      connectionFingerprint: linearFingerprint(c),
      issueId,
      createdAt: removedAt,
      state: 'complete',
      error: null,
      retryAt: 0,
      attempts: 0,
    });
  if (
    issue &&
    tombstone &&
    Date.parse(issue.updatedAt) <= Date.parse(tombstone.createdAt)
  )
    return null;
  if (
    previous &&
    issue &&
    Date.parse(issue.updatedAt) < Date.parse(previous.linear!.updatedAt)
  )
    return null;
  const mapping = issue
    ? linearMappings(
        linearConnections(paths),
        c.organizationId,
        issue.team.id,
        issue.project?.id ?? null,
      )
    : [];
  const baseline = issue ? linearContentFingerprint(issue) : '';
  // Read-only recovery of a retained uncertain effect; never resends a mutation.
  for (const effect of linearRecords(db, 'writeback', {
    connectionId: c.id,
    issueId,
  }).filter(
    (e) =>
      e.connectionId === c.id &&
      e.issueId === issueId &&
      ['sending', 'uncertain'].includes(e.state),
  )) {
    const matched =
      matchesLinearSourceBinding(effect, c) &&
      effect.sourceVersion === previous?.version &&
      effect.baseline === baseline &&
      effect.stateId === issue?.state.id;
    putLinearRecord(db, {
      ...effect,
      state: matched ? 'complete' : 'attention',
      updatedAt: matched ? issue!.updatedAt : effect.updatedAt,
      error: matched
        ? null
        : 'Uncertain state update does not match the current source. Review current Linear state.',
    });
  }
  const effects = linearRecords(db, 'writeback', {
    connectionId: c.id,
    issueId,
  }).filter(
    (e) =>
      e.connectionId === c.id &&
      matchesLinearSourceBinding(e, c) &&
      e.sourceVersion === previous?.version &&
      (e.state !== 'complete' ||
        e.updatedAt === issue?.updatedAt ||
        previous?.linear?.stateId === issue?.state.id) &&
      e.issueId === issueId &&
      e.baseline === baseline &&
      e.stateId === issue?.state.id &&
      ['sending', 'uncertain', 'complete'].includes(e.state),
  );
  const echo = effects.length > 0;
  const eligible =
    !!issue &&
    mapping.length === 1 &&
    mapping[0].id === c.id &&
    (linearEligible(c, issue) || echo);
  const closed =
    !issue ||
    !!issue.archivedAt ||
    (!echo && ['completed', 'canceled'].includes(issue.state.type)) ||
    !eligible;
  if (!previous && closed) return null;
  if (
    previous &&
    issue &&
    Date.parse(issue.updatedAt) < Date.parse(previous.linear!.updatedAt)
  )
    return null;
  const fingerprint = linearFingerprint({
    baseline,
    state: echo ? previous?.linear?.stateId : issue?.state.id,
    closed,
  });
  const remote = issue
    ? {
        connectionId: c.id,
        organizationId: c.organizationId,
        issueId,
        identifier: issue.identifier,
        teamId: issue.team.id,
        projectId: issue.project?.id ?? null,
        stateId: issue.state.id,
        stateType: issue.state.type,
        updatedAt: issue.updatedAt,
        fingerprint,
        url: issue.url,
      }
    : {
        ...previous!.linear!,
        updatedAt: removedAt ?? previous!.linear!.updatedAt,
      };
  if (!previous) {
    const now = new Date().toISOString();
    const source = v.parse(sourceSchema, {
      id: randomUUID(),
      provider: 'linear',
      requestKey: key,
      requestHash: fingerprint,
      title: issue!.title,
      body: issue!.description ?? '',
      repoId: c.repoId,
      linear: remote,
      version: 1,
      status: 'open',
      actor: c.id,
      createdAt: now,
    });
    const item: FactoryWork = {
      id: randomUUID(),
      sourceId: source.id,
      title: source.title,
      repoId: c.repoId,
      lifecycle: 'inbox',
      version: 1,
      specVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    db.prepare(
      'INSERT INTO factory_sources(id,request_key,record) VALUES(?,?,?)',
    ).run(source.id, key, JSON.stringify(source));
    db.prepare(
      'INSERT INTO factory_work_items(id,source_id,record) VALUES(?,?,?)',
    ).run(item.id, source.id, JSON.stringify(item));
    insertRevision(
      db,
      item,
      source,
      emptyFactorySpec(),
      { kind: 'source', id: c.id },
      repoSnapshot(c.repoId, paths),
    );
    audit(db, item.id, 'linear-intake', { kind: 'source', id: c.id });
    return detail(db, item.id, paths);
  }
  const workRow = db
    .prepare('SELECT record FROM factory_work_items WHERE source_id=?')
    .get(previous.id)!;
  const item = v.parse(workSchema, JSON.parse(String(workRow.record)));
  const current = detail(db, item.id, paths);
  const mappingChanged =
    previous.repoId !== c.repoId || previous.linear?.connectionId !== c.id;
  const changed =
    closed !== (previous.status === 'closed') ||
    mappingChanged ||
    (!echo && previous.linear?.fingerprint !== fingerprint) ||
    (echo &&
      (previous.title !== issue!.title ||
        previous.body !== (issue!.description ?? '')));
  if (changed) {
    withdraw(db, current.releases, 'linear-source-changed');
    previous.version++;
    previous.title = issue?.title ?? previous.title;
    previous.body = issue ? (issue.description ?? '') : previous.body;
    previous.status = closed ? 'closed' : 'open';
    item.title = previous.title;
    if (closed) item.lifecycle = 'paused';
    else if (item.lifecycle === 'queued' || current.source.status === 'closed')
      item.lifecycle = 'shaping';
    putWork(db, item);
    audit(db, item.id, 'linear-source-reconciled', {
      kind: 'source',
      id: c.id,
    });
  }
  const confirmationRequired =
    previous.linear?.sourceConfirmationRequired === true ||
    previous.attention?.startsWith('Linear connection changed.') === true;
  const sourceConfirmed = !closed && !mappingChanged;
  previous.attention = confirmationRequired
    ? sourceConfirmed
      ? null
      : 'Linear connection changed. Sync an eligible source with the original repository mapping before release.'
    : previous.attention?.includes('Review and save a new draft')
      ? previous.attention
      : mappingChanged
        ? 'Linear mapping changed. Restore the original repository mapping before release.'
        : !eligible
          ? 'Linear source is removed or no longer eligible.'
          : null;
  if (!mappingChanged) previous.linear = remote;
  if (confirmationRequired)
    previous.linear!.sourceConfirmationRequired = !sourceConfirmed;
  if (echo) previous.linear!.fingerprint = current.source.linear!.fingerprint;
  db.prepare('UPDATE factory_sources SET record=? WHERE id=?').run(
    JSON.stringify(previous),
    previous.id,
  );
  clearLinearReadFailure(db, previous.id);
  return detail(db, item.id, paths);
}
