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
type RevisionActor = FactoryActor | { kind: 'model' | 'source'; id: string };
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
export function dbRun<T>(paths: RuntimePaths, run: (db: DatabaseSync) => T) {
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
export function detail(
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
  if (source.remote) {
    const mappings = (config(paths)?.github ?? []).filter(
      (c) => c.enabled && c.repositoryId === source.remote!.repositoryId,
    );
    const mapping = mappings[0];
    const registered = repos(paths).find((repo) => repo.id === item.repoId);
    if (
      mappings.length !== 1 ||
      mapping.id !== source.remote.connectionId ||
      mapping.repoId !== item.repoId ||
      !registered ||
      registered.github.owner.toLowerCase() !== mapping.owner.toLowerCase() ||
      registered.github.name.toLowerCase() !== mapping.name.toLowerCase()
    )
      blockers.push(
        'GitHub source mapping is disabled, changed or ambiguous. Restore the intended mapping before release.',
      );
  }
  if (source.attention) blockers.push(source.attention);
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
export function requireEnabled(paths: RuntimePaths) {
  if (!config(paths)?.enabled)
    throw new FactoryError(
      403,
      'Factory is disabled. Enable factory.enabled in local configuration.',
    );
}
export function expectVersion(current: FactoryDetail, expected: number) {
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
  actor: RevisionActor,
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
  actor: RevisionActor,
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
    authorKind: actor.kind,
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
      attention: null,
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
  return dbRun(paths, (db) =>
    saveSpecInTransaction(db, id, data, actor, paths),
  );
}
// Internal domain operation; callers must establish human or bound planner authority.
export function saveSpecInTransaction(
  db: DatabaseSync,
  id: string,
  data: v.InferOutput<typeof saveSpecSchema>,
  actor: RevisionActor,
  paths: RuntimePaths,
) {
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
  if (current.source.attention?.includes('Review and save a new draft')) {
    current.source.attention = null;
    db.prepare('UPDATE factory_sources SET record=? WHERE id=?').run(
      JSON.stringify(current.source),
      current.source.id,
    );
  }
  current.work.specVersion++;
  if (current.work.lifecycle !== 'paused') current.work.lifecycle = 'shaping';
  insertRevision(db, current.work, current.source, data.spec, actor, current);
  putWork(db, current.work);
  audit(db, id, 'spec-saved', actor);
  return detail(db, id, paths);
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
    withdraw(db, current.releases, data.action);
    current.work.lifecycle =
      data.action === 'pause'
        ? 'paused'
        : data.action === 'close'
          ? 'closed'
          : 'shaping';
    if (
      current.source.provider === 'manual' &&
      (data.action === 'close' || data.action === 'reopen')
    ) {
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
    if (current.source.provider !== 'manual')
      throw new FactoryError(
        409,
        'GitHub source is read-only. Sync the source or edit the brief.',
      );
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

/** Internal reconciler boundary. Never registered as a model tool or human API. */
export function reconcileGitHubSource(
  db: DatabaseSync,
  input: {
    connectionId: string;
    repositoryId: string;
    repoId: string;
    owner: string;
    name: string;
    issue: import('../../../shared/factory-github').GitHubIssue;
  },
  paths: RuntimePaths,
) {
  const { issue } = input;
  const key = `github:${input.repositoryId}:${issue.id}`;
  const previous = records(
    db,
    'SELECT record FROM factory_sources WHERE request_key=?',
    sourceSchema,
    key,
  )[0];
  const fingerprint = digest({
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
  });
  const remote = {
    connectionId: input.connectionId,
    repositoryId: input.repositoryId,
    issueId: String(issue.id),
    number: issue.number,
    updatedAt: issue.updated_at,
    fingerprint,
    url: `https://github.com/${input.owner}/${input.name}/issues/${issue.number}`,
  };
  if (!previous) {
    const now = new Date().toISOString();
    const source = parse(sourceSchema, {
      id: randomUUID(),
      provider: 'github',
      requestKey: key,
      requestHash: fingerprint,
      title: issue.title,
      body: issue.body ?? '',
      repoId: input.repoId,
      remote,
      version: 1,
      status: issue.state,
      actor: issue.user?.login ?? 'deleted-user',
      createdAt: now,
    });
    const item: FactoryWork = {
      id: randomUUID(),
      sourceId: source.id,
      title: source.title,
      repoId: source.repoId,
      lifecycle: issue.state === 'closed' ? 'paused' : 'inbox',
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
    // Full source stays canonical; the initial empty brief is never a truncated source copy.
    insertRevision(
      db,
      item,
      source,
      emptyFactorySpec(),
      { kind: 'source', id: `github:${source.actor}` },
      repoSnapshot(item.repoId, paths),
    );
    audit(db, item.id, 'github-intake', {
      kind: 'source',
      id: input.connectionId,
    });
    return detail(db, item.id, paths);
  }
  const item = records(
    db,
    'SELECT record FROM factory_work_items WHERE source_id=?',
    workSchema,
    previous.id,
  )[0];
  const current = detail(db, item.id, paths);
  if (
    previous.remote?.connectionId !== input.connectionId ||
    previous.repoId !== input.repoId
  ) {
    markGitHubAttention(
      db,
      item.id,
      'Repository mapping changed. Restore the original mapping before reconciling this task.',
      paths,
    );
    throw new FactoryError(409, 'Source already belongs to another mapping.');
  }
  if (Date.parse(issue.updated_at) < Date.parse(previous.remote.updatedAt))
    return current;
  const changed = previous.remote.fingerprint !== fingerprint;
  const equalRevisionConflict =
    changed && issue.updated_at === previous.remote.updatedAt;
  if (changed) {
    withdraw(db, current.releases, 'github-source-changed');
    previous.version++;
    Object.assign(previous, {
      title: issue.title,
      body: issue.body ?? '',
      status: issue.state,
    });
    item.title = issue.title;
    if (issue.state === 'closed') item.lifecycle = 'paused';
    else if (current.source.status === 'closed' || item.lifecycle === 'queued')
      item.lifecycle = 'shaping';
    putWork(db, item);
    audit(db, item.id, 'github-source-reconciled', {
      kind: 'source',
      id: input.connectionId,
    });
  }
  previous.remote = remote;
  previous.attention = equalRevisionConflict
    ? 'GitHub returned changed content at the same timestamp. Review and save a new draft.'
    : previous.attention?.includes('Review and save a new draft')
      ? previous.attention
      : null;
  db.prepare('UPDATE factory_sources SET record=? WHERE id=?').run(
    JSON.stringify(previous),
    previous.id,
  );
  return detail(db, item.id, paths);
}
export function markGitHubAttention(
  db: DatabaseSync,
  workId: string,
  reason: string,
  paths: RuntimePaths,
) {
  const current = detail(db, workId, paths);
  if (current.source.attention === reason) return;
  current.source.attention = reason;
  current.source.version++;
  withdraw(db, current.releases, 'github-needs-review');
  if (current.work.lifecycle === 'queued') current.work.lifecycle = 'shaping';
  putWork(db, current.work);
  db.prepare('UPDATE factory_sources SET record=? WHERE id=?').run(
    JSON.stringify(current.source),
    current.source.id,
  );
  audit(db, workId, 'github-needs-review', {
    kind: 'source',
    id: current.source.remote?.connectionId ?? 'github',
  });
}
