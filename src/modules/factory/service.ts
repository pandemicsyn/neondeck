import { publishFactoryChange } from './events';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import {
  emptyFactorySpec,
  factoryPolicy,
  manualIntakeSchema,
  sourceSchema,
  workSchema,
  revisionSchema,
  releaseSchema,
  saveSpecSchema,
  releaseInputSchema,
  transitionSchema,
  updateSourceSchema,
  type FactoryDetail,
  type FactoryWork,
  type FactorySource,
  type FactoryRevision,
  type FactoryRelease,
} from '../../../shared/factory';
import { openDb, withImmediateTransaction } from '../../lib/sqlite';
import {
  readRuntimeJsonSync,
  parseAppConfig,
  parseRepoRegistry,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';

export class FactoryError extends Error {
  constructor(
    public status: 400 | 403 | 404 | 409,
    message: string,
    public current?: FactoryDetail,
  ) {
    super(message);
  }
}
export type FactoryActor = { kind: 'human'; id: string };
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
function parse<T>(schema: v.GenericSchema<unknown, T>, value: unknown): T {
  const result = v.safeParse(schema, value);
  if (!result.success) throw new FactoryError(400, v.summarize(result.issues));
  return result.output;
}
function config(paths: RuntimePaths) {
  return readRuntimeJsonSync(paths.config, parseAppConfig).factory;
}
function repos(paths: RuntimePaths) {
  return readRuntimeJsonSync(paths.repos, parseRepoRegistry).repos;
}
function repoSnapshot(repoId: string | null, paths: RuntimePaths) {
  const repo = repos(paths).find((r) => r.id === repoId);
  return {
    repoFingerprint: repo ? digest(repo) : null,
    repoContext: repo
      ? {
          path: repo.path,
          defaultBranch: repo.defaultBranch,
          commands: repo.packageScripts ?? {},
        }
      : null,
  };
}
function repoFingerprint(repoId: string | null, paths: RuntimePaths) {
  return repoSnapshot(repoId, paths).repoFingerprint;
}
function dbRun<T>(paths: RuntimePaths, run: (db: DatabaseSync) => T) {
  const db = openDb(paths.neondeckDatabase);
  try {
    const result = withImmediateTransaction(db, () => run(db));
    const changes = db.prepare('SELECT total_changes() AS count').get();
    if (Number(changes?.count) > 0) publishFactoryChange();
    return result;
  } finally {
    db.close();
  }
}
function records<T>(
  db: DatabaseSync,
  sql: string,
  schema: v.GenericSchema<unknown, T>,
  ...args: (string | number)[]
): T[] {
  return db
    .prepare(sql)
    .all(...args)
    .map((row) => v.parse(schema, JSON.parse(v.parse(v.string(), row.record))));
}
function work(db: DatabaseSync, id: string) {
  const result = records(
    db,
    'SELECT record FROM factory_work_items WHERE id=?',
    workSchema,
    id,
  )[0];
  if (!result) throw new FactoryError(404, 'Task not found.');
  return result;
}
function detail(
  db: DatabaseSync,
  id: string,
  paths: RuntimePaths,
): FactoryDetail {
  const item = work(db, id);
  const source = records(
    db,
    'SELECT record FROM factory_sources WHERE id=?',
    sourceSchema,
    item.sourceId,
  )[0];
  const revisions = records(
    db,
    'SELECT record FROM factory_spec_revisions WHERE work_id=? ORDER BY version',
    revisionSchema,
    id,
  );
  const releases = records(
    db,
    'SELECT record FROM factory_releases WHERE work_id=? ORDER BY rowid',
    releaseSchema,
    id,
  );
  const revision = revisions.at(-1)!;
  const context = repoSnapshot(item.repoId, paths);
  const fingerprint = context.repoFingerprint;
  const blockers: string[] = [];
  if (!config(paths)?.enabled) blockers.push('Factory is disabled.');
  if (!fingerprint) blockers.push('Select a registered repository.');
  if (source.repoId !== item.repoId)
    blockers.push('Source repository does not match task repository.');
  if (source.status === 'closed') blockers.push('Source is closed.');
  if (item.lifecycle === 'paused' || item.lifecycle === 'closed')
    blockers.push('Reopen this task before release.');
  if (
    revision.sourceVersion !== source.version ||
    revision.repoFingerprint !== fingerprint
  )
    blockers.push(
      'Source or repository context changed. Review and save a new draft.',
    );
  if (
    !revision.spec.outcome.trim() ||
    !revision.spec.scope.trim() ||
    !revision.spec.approach.trim() ||
    !revision.spec.acceptanceCriteria.length
  )
    blockers.push(
      'Add outcome, scope, approach and at least one acceptance criterion.',
    );
  if (revision.spec.decisions.some((d) => d.blocking && !d.answer?.trim()))
    blockers.push('Resolve blocking decisions before release.');
  const active = releases.find((r) => !r.withdrawnAt);
  const eligible =
    item.lifecycle === 'queued' &&
    blockers.length === 0 &&
    !!active &&
    active.specVersion === revision.version &&
    active.specHash === revision.hash &&
    active.sourceVersion === source.version &&
    active.repoFingerprint === fingerprint &&
    active.policy.version === config(paths)?.codingPolicy;
  return {
    work: item,
    source,
    revisions,
    releases,
    blockers,
    eligible,
    ...context,
  };
}
function requireHuman(actor: FactoryActor) {
  if (actor.kind !== 'human' || !actor.id.trim())
    throw new FactoryError(
      403,
      'Only the local human operator can change factory work.',
    );
}
function requireEnabled(paths: RuntimePaths) {
  if (!config(paths)?.enabled)
    throw new FactoryError(
      403,
      'Factory is disabled. Enable factory.enabled in local configuration.',
    );
}
function expectVersion(current: FactoryDetail, expected: number) {
  if (current.work.version !== expected)
    throw new FactoryError(
      409,
      'Task changed. Review the latest version before retrying.',
      current,
    );
}
function putWork(db: DatabaseSync, item: FactoryWork) {
  item.version++;
  item.updatedAt = new Date().toISOString();
  db.prepare('UPDATE factory_work_items SET record=? WHERE id=?').run(
    JSON.stringify(item),
    item.id,
  );
}
function audit(
  db: DatabaseSync,
  id: string,
  action: string,
  actor: FactoryActor,
) {
  db.prepare(
    'INSERT INTO factory_audit (work_id,action,actor,created_at) VALUES (?,?,?,?)',
  ).run(id, action, actor.id, new Date().toISOString());
}
function withdraw(
  db: DatabaseSync,
  releases: FactoryRelease[],
  reason: string,
) {
  for (const release of releases.filter((r) => !r.withdrawnAt)) {
    release.withdrawnAt = new Date().toISOString();
    release.withdrawalReason = reason;
    db.prepare('UPDATE factory_releases SET record=? WHERE id=?').run(
      JSON.stringify(release),
      release.id,
    );
  }
}
function insertRevision(
  db: DatabaseSync,
  item: FactoryWork,
  source: FactorySource,
  spec: FactoryRevision['spec'],
  actor: FactoryActor,
  context: Pick<FactoryDetail, 'repoFingerprint' | 'repoContext'>,
) {
  const revision: FactoryRevision = {
    workId: item.id,
    version: item.specVersion,
    parentVersion: item.specVersion === 1 ? null : item.specVersion - 1,
    spec,
    hash: digest(spec),
    sourceVersion: source.version,
    repoFingerprint: context.repoFingerprint,
    repoContext: context.repoContext,
    authorKind: 'human',
    actor: actor.id,
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    'INSERT INTO factory_spec_revisions (work_id,version,record) VALUES (?,?,?)',
  ).run(item.id, revision.version, JSON.stringify(revision));
}
export function factoryState(paths = runtimePaths()) {
  return dbRun(paths, (db) => ({
    enabled: config(paths)?.enabled ?? false,
    policy: factoryPolicy.version,
    repos: repos(paths).map((r) => ({
      id: r.id,
      name: `${r.github.owner}/${r.github.name}`,
    })),
    items: records(
      db,
      'SELECT record FROM factory_work_items ORDER BY rowid DESC',
      workSchema,
    ),
  }));
}
export function getFactoryWork(id: string, paths = runtimePaths()) {
  return dbRun(paths, (db) => detail(db, id, paths));
}
export function submitFactoryWork(
  input: unknown,
  actor: FactoryActor,
  paths = runtimePaths(),
) {
  requireHuman(actor);
  const data = parse(manualIntakeSchema, input);
  return dbRun(paths, (db) => {
    requireEnabled(paths);
    const previous = records(
      db,
      'SELECT record FROM factory_sources WHERE request_key=?',
      sourceSchema,
      data.requestKey,
    )[0];
    if (previous) {
      if (previous.requestHash !== digest(data))
        throw new FactoryError(
          409,
          'Request key already belongs to different intake content.',
        );
      const item = records(
        db,
        'SELECT record FROM factory_work_items WHERE source_id=?',
        workSchema,
        previous.id,
      )[0];
      return detail(db, item.id, paths);
    }
    if (data.repoId && !repoFingerprint(data.repoId, paths))
      throw new FactoryError(400, 'Select a registered repository.');
    const now = new Date().toISOString();
    const source: FactorySource = {
      ...data,
      id: randomUUID(),
      provider: 'manual',
      requestHash: digest(data),
      version: 1,
      status: 'open',
      actor: actor.id,
      createdAt: now,
    };
    const item: FactoryWork = {
      id: randomUUID(),
      sourceId: source.id,
      title: data.title,
      repoId: data.repoId,
      lifecycle: 'inbox',
      version: 1,
      specVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    db.prepare(
      'INSERT INTO factory_sources (id,request_key,record) VALUES (?,?,?)',
    ).run(source.id, data.requestKey, JSON.stringify(source));
    db.prepare(
      'INSERT INTO factory_work_items (id,source_id,record) VALUES (?,?,?)',
    ).run(item.id, source.id, JSON.stringify(item));
    insertRevision(
      db,
      item,
      source,
      { ...emptyFactorySpec(), outcome: data.body },
      actor,
      repoSnapshot(item.repoId, paths),
    );
    audit(db, item.id, 'manual-intake', actor);
    return detail(db, item.id, paths);
  });
}
export function saveFactorySpec(
  id: string,
  input: unknown,
  actor: FactoryActor,
  paths = runtimePaths(),
) {
  requireHuman(actor);
  const data = parse(saveSpecSchema, input);
  return dbRun(paths, (db) => {
    requireEnabled(paths);
    const current = detail(db, id, paths);
    expectVersion(current, data.expectedVersion);
    if (data.expectedRepoFingerprint !== current.repoFingerprint)
      throw new FactoryError(
        409,
        'Repository configuration changed. Review the current repository context before saving; your draft is retained.',
        current,
      );
    if (current.work.specVersion !== data.expectedSpecVersion)
      throw new FactoryError(409, 'Draft changed.', current);
    if (current.work.lifecycle === 'closed')
      throw new FactoryError(409, 'Reopen this task before editing.', current);
    withdraw(db, current.releases, 'new-spec-revision');
    current.work.specVersion++;
    if (current.work.lifecycle !== 'paused') current.work.lifecycle = 'shaping';
    insertRevision(db, current.work, current.source, data.spec, actor, current);
    putWork(db, current.work);
    audit(db, id, 'spec-saved', actor);
    return detail(db, id, paths);
  });
}
export function releaseFactoryWork(
  id: string,
  input: unknown,
  actor: FactoryActor,
  paths = runtimePaths(),
) {
  requireHuman(actor);
  const data = parse(releaseInputSchema, input);
  return dbRun(paths, (db) => {
    requireEnabled(paths);
    const current = detail(db, id, paths);
    const previous = current.releases.find(
      (r) => r.requestKey === data.requestKey,
    );
    if (previous) {
      if (
        previous.specVersion !== data.specVersion ||
        previous.specHash !== data.specHash ||
        previous.sourceVersion !== data.sourceVersion ||
        previous.repoFingerprint !== data.repoFingerprint ||
        previous.policy.version !== data.policyVersion ||
        previous.actor !== actor.id
      )
        throw new FactoryError(
          409,
          'Release request key was used for another decision.',
          current,
        );
      // A retry never resurrects withdrawn authority or bypasses fresh eligibility checks.
      return current;
    }
    expectVersion(current, data.expectedVersion);
    const revision = current.revisions.at(-1)!;
    if (
      revision.version !== data.specVersion ||
      revision.hash !== data.specHash ||
      current.source.version !== data.sourceVersion ||
      current.repoFingerprint !== data.repoFingerprint
    )
      throw new FactoryError(
        409,
        'Release context changed. Review the current draft.',
        current,
      );
    if (current.blockers.length)
      throw new FactoryError(409, current.blockers.join(' '), current);
    const active = current.releases.find((r) => !r.withdrawnAt);
    if (active) return current;
    const decision: FactoryRelease = {
      id: randomUUID(),
      workId: id,
      requestKey: data.requestKey,
      actor: actor.id,
      specVersion: revision.version,
      specHash: revision.hash,
      sourceVersion: current.source.version,
      repoId: current.work.repoId!,
      repoFingerprint: current.repoFingerprint!,
      policy: factoryPolicy,
      createdAt: new Date().toISOString(),
      withdrawnAt: null,
      withdrawalReason: null,
    };
    db.prepare(
      'INSERT INTO factory_releases (id,work_id,request_key,record) VALUES (?,?,?,?)',
    ).run(decision.id, id, data.requestKey, JSON.stringify(decision));
    current.work.lifecycle = 'queued';
    putWork(db, current.work);
    audit(db, id, 'released', actor);
    return detail(db, id, paths);
  });
}
export function transitionFactoryWork(
  id: string,
  input: unknown,
  actor: FactoryActor,
  paths = runtimePaths(),
) {
  requireHuman(actor);
  const data = parse(transitionSchema, input);
  return dbRun(paths, (db) => {
    // Revocation remains possible when factory is disabled.
    if (data.action === 'reopen') requireEnabled(paths);
    const current = detail(db, id, paths);
    expectVersion(current, data.expectedVersion);
    if (data.action === 'withdraw' && current.work.lifecycle !== 'queued')
      throw new FactoryError(
        409,
        'Only a queued release can be withdrawn.',
        current,
      );
    if (
      data.action === 'reopen' &&
      !['paused', 'closed'].includes(current.work.lifecycle)
    )
      throw new FactoryError(
        409,
        'Only paused or closed tasks can be reopened.',
        current,
      );
    if (data.action === 'pause' && current.work.lifecycle === 'closed')
      throw new FactoryError(
        409,
        'Closed tasks must be reopened first.',
        current,
      );
    const reopeningClosed =
      data.action === 'reopen' && current.work.lifecycle === 'closed';
    withdraw(db, current.releases, data.action);
    current.work.lifecycle =
      data.action === 'pause'
        ? 'paused'
        : data.action === 'close'
          ? 'closed'
          : 'shaping';
    if (data.action === 'close' || reopeningClosed) {
      current.source.status = data.action === 'close' ? 'closed' : 'open';
      current.source.version++;
      db.prepare('UPDATE factory_sources SET record=? WHERE id=?').run(
        JSON.stringify(current.source),
        current.source.id,
      );
    }
    putWork(db, current.work);
    audit(db, id, data.action, actor);
    return detail(db, id, paths);
  });
}
export function updateFactorySource(
  id: string,
  input: unknown,
  actor: FactoryActor,
  paths = runtimePaths(),
) {
  requireHuman(actor);
  const data = parse(updateSourceSchema, input);
  return dbRun(paths, (db) => {
    requireEnabled(paths);
    const current = detail(db, id, paths);
    expectVersion(current, data.expectedVersion);
    if (
      data.title === current.source.title &&
      data.body === current.source.body &&
      data.repoId === current.source.repoId
    )
      return current;
    if (data.repoId && !repoFingerprint(data.repoId, paths))
      throw new FactoryError(400, 'Select a registered repository.');
    if (current.work.lifecycle === 'closed')
      throw new FactoryError(409, 'Reopen this task before editing.', current);
    withdraw(db, current.releases, 'source-or-repo-changed');
    Object.assign(current.source, {
      title: data.title,
      body: data.body,
      repoId: data.repoId,
      version: current.source.version + 1,
    });
    Object.assign(current.work, { title: data.title, repoId: data.repoId });
    if (current.work.lifecycle === 'queued') current.work.lifecycle = 'shaping';
    db.prepare('UPDATE factory_sources SET record=? WHERE id=?').run(
      JSON.stringify(current.source),
      current.source.id,
    );
    putWork(db, current.work);
    audit(db, id, 'source-updated', actor);
    return detail(db, id, paths);
  });
}
