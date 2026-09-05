import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as v from 'valibot';
import type { DatabaseSync } from 'node:sqlite';
import {
  planningInputSchema,
  triageResultSchema,
  type FactoryPlanningState,
} from '../../../shared/factory-planning';
import { factoryDiscussionText } from '../../../shared/factory-document';
import { factoryDetailSchema, saveSpecSchema } from '../../../shared/factory';
import { runtimePaths, type RuntimePaths } from '../../runtime-home';
import { buildMemoryPromptSnapshotSync } from '../memory';
import {
  readAgentModelSelectionSync,
  runtimeSkillSessionSnapshotsSync,
} from '../runtime';
import {
  registerFactoryPlannerSession,
  readFactoryPlannerSession,
} from '../sessions';
import {
  dbRun,
  detail,
  expectVersion,
  requireEnabled,
  FactoryError,
  saveSpecInTransaction,
} from './service';
import { captureRepoCommit } from './repo-tools';
const str = v.string();
const nullable = v.nullable(str);
const contextSchema = v.object({
  capturedAt: str,
  model: str,
  utilityModel: str,
  thinkingLevel: v.picklist([
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
  ]),
  utilityThinkingLevel: v.picklist([
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
  ]),
  soul: str,
  memory: str,
  memoryIds: v.array(str),
  skills: v.array(v.object({ name: str, instructions: str })),
  repoCommit: nullable,
  repoPath: nullable,
  repoFingerprint: nullable,
  sourceVersion: v.number(),
});
const bindingSchema = v.object({
  workId: str,
  sessionId: str,
  context: contextSchema,
});
export const intentSchema = v.object({
  id: str,
  workId: str,
  sessionId: str,
  requestKey: str,
  requestHash: str,
  message: str,
  snapshot: factoryDetailSchema,
  context: contextSchema,
  triageOnly: v.optional(v.boolean(), false),
  stage: v.picklist(['triage', 'planner', 'completed', 'failed']),
  triage: v.nullable(triageResultSchema),
  triageModel: v.optional(nullable, null),
  triageCandidates: v.array(v.object({ id: str, title: str })),
  triageSubmissionId: nullable,
  submissionId: nullable,
  error: nullable,
  createdAt: str,
  abortRequested: v.optional(v.boolean(), false),
});
export type PlanningIntent = v.InferOutput<typeof intentSchema>;
export type PlanningBinding = v.InferOutput<typeof bindingSchema>;
export const hashPlanning = (x: unknown) =>
  createHash('sha256').update(JSON.stringify(x)).digest('hex');
function read<T>(
  db: DatabaseSync,
  sql: string,
  schema: v.GenericSchema<unknown, T>,
  ...args: string[]
) {
  const row = db.prepare(sql).get(...args);
  return row ? v.parse(schema, JSON.parse(v.parse(str, row.record))) : null;
}
export function readBinding(db: DatabaseSync, workId: string) {
  return read(
    db,
    'SELECT record FROM factory_planning_bindings WHERE work_id=?',
    bindingSchema,
    workId,
  );
}
export function readIntent(db: DatabaseSync, id: string) {
  const intent = read(
    db,
    'SELECT record FROM factory_planning_intents WHERE id=?',
    intentSchema,
    id,
  );
  if (!intent) throw new FactoryError(404, 'Planning request not found.');
  return intent;
}
export function writeIntent(db: DatabaseSync, intent: PlanningIntent) {
  v.parse(intentSchema, intent);
  db.prepare('UPDATE factory_planning_intents SET record=? WHERE id=?').run(
    JSON.stringify(intent),
    intent.id,
  );
}
function latestIntent(db: DatabaseSync, workId: string) {
  return read(
    db,
    'SELECT record FROM factory_planning_intents WHERE work_id=? ORDER BY rowid DESC LIMIT 1',
    intentSchema,
    workId,
  );
}
function captureContext(
  current: ReturnType<typeof detail>,
  paths: RuntimePaths,
) {
  const models = readAgentModelSelectionSync(paths);
  const memory = buildMemoryPromptSnapshotSync(paths, {
    repoId: current.work.repoId,
  });
  let soul = '';
  try {
    soul = readFileSync(paths.soul, 'utf8').slice(0, 12000);
  } catch {
    /* Optional SOUL. */
  }
  return v.parse(contextSchema, {
    capturedAt: new Date().toISOString(),
    model: models.displayAssistant,
    utilityModel: models.utility,
    thinkingLevel: models.displayAssistantThinkingLevel,
    utilityThinkingLevel: models.utilityThinkingLevel,
    soul,
    memory: memory.instructions.slice(0, 16000),
    memoryIds: memory.memoryIds,
    skills: runtimeSkillSessionSnapshotsSync(paths)
      .slice(0, 8)
      .map((s) => ({
        name: s.name,
        instructions: s.instructions.slice(0, 6000),
      })),
    repoCommit: captureRepoCommit(current.repoContext?.path ?? null),
    repoPath: current.repoContext?.path ?? null,
    repoFingerprint: current.repoFingerprint,
    sourceVersion: current.source.version,
  });
}
function contextChanged(
  binding: PlanningBinding,
  current: ReturnType<typeof detail>,
  paths: RuntimePaths,
) {
  const fresh = captureContext(current, paths);
  const { capturedAt: _freshTime, ...next } = fresh;
  const { capturedAt: _oldTime, ...old } = binding.context;
  return hashPlanning(next) !== hashPlanning(old);
}
export function prepareFactoryPlanning(
  workId: string,
  input: unknown,
  paths = runtimePaths(),
  triageOnly = false,
) {
  const data = v.parse(planningInputSchema, input);
  return dbRun(paths, (db) => {
    requireEnabled(paths);
    const prior = read(
      db,
      'SELECT record FROM factory_planning_intents WHERE work_id=? AND request_key=?',
      intentSchema,
      workId,
      data.requestKey,
    );
    if (prior) {
      if (prior.requestHash !== hashPlanning(data))
        throw new FactoryError(409, 'Request key belongs to another message.');
      return prior;
    }
    const current = detail(db, workId, paths);
    expectVersion(current, data.expectedVersion);
    let message = data.message;
    if (data.discussion) {
      const ref = data.discussion;
      const revision = current.revisions.find(
        (r) => r.version === ref.version && r.hash === ref.hash,
      );
      const context = revision && factoryDiscussionText(revision.spec, ref);
      if (!context)
        throw new FactoryError(
          409,
          'Discussion reference is not retained in this task.',
        );
      // Persist the resolved, original revision in the ordinary message. No client
      // session/work ID or free-form reference can broaden planner authority.
      message = `Discussing brief v${ref.version} (${ref.hash}), ${ref.kind}:${ref.id} — ${context.label}.\nThis is revision-bound context, not approval or a spec mutation.\n${context.text.slice(0, 6000)}${context.text.length > 6000 ? '\n[Excerpt limited to 6000 characters]' : ''}\n\nHuman feedback:\n${data.message}`;
    }
    if (['paused', 'closed', 'queued'].includes(current.work.lifecycle))
      throw new FactoryError(
        409,
        'Reopen or withdraw release before planning.',
      );
    const previous = latestIntent(db, workId);
    if (previous && ['triage', 'planner'].includes(previous.stage))
      throw new FactoryError(
        409,
        'A planning request is pending. Wait or stop it before sending another.',
      );
    let binding = readBinding(db, workId);
    if (!binding) {
      binding = {
        workId,
        sessionId: `factory-${randomUUID()}`,
        context: captureContext(current, paths),
      };
      registerFactoryPlannerSession(db, {
        ...binding,
        repoId: current.work.repoId,
        title: current.work.title,
        capturedAt: binding.context.capturedAt,
        memoryIds: binding.context.memoryIds,
      });
      db.prepare(
        'INSERT INTO factory_planning_bindings (work_id,session_id,record) VALUES (?,?,?)',
      ).run(workId, binding.sessionId, JSON.stringify(binding));
    }
    if (!triageOnly && contextChanged(binding, current, paths))
      throw new FactoryError(
        409,
        'Planning context changed. Refresh it explicitly before sending.',
      );
    const reusableTriage =
      previous?.context.sourceVersion === current.source.version &&
      previous.context.repoFingerprint === current.repoFingerprint
        ? previous.triage
        : null;
    const intent: PlanningIntent = {
      id: randomUUID(),
      workId,
      sessionId: binding.sessionId,
      requestKey: data.requestKey,
      requestHash: hashPlanning(data),
      message,
      snapshot: {
        ...current,
        revisions: current.revisions.slice(-1),
        releases: [],
      },
      context: triageOnly ? captureContext(current, paths) : binding.context,
      triageOnly,
      stage: !triageOnly && reusableTriage ? 'planner' : 'triage',
      triage: !triageOnly ? reusableTriage : null,
      triageModel: reusableTriage && !triageOnly ? previous!.triageModel : null,
      triageCandidates: db
        .prepare(
          'SELECT id,record FROM factory_work_items WHERE id<>? ORDER BY rowid DESC LIMIT 10',
        )
        .all(workId)
        .map((row) => ({
          id: String(row.id),
          title: String(JSON.parse(String(row.record)).title).slice(0, 240),
        })),
      triageSubmissionId: null,
      submissionId: null,
      error: null,
      createdAt: new Date().toISOString(),
      abortRequested: false,
    };
    db.prepare(
      'INSERT INTO factory_planning_intents (id,work_id,request_key,record) VALUES (?,?,?,?)',
    ).run(intent.id, workId, data.requestKey, JSON.stringify(intent));
    return intent;
  });
}
export function refreshFactoryPlanningContext(
  workId: string,
  expectedVersion: number,
  paths = runtimePaths(),
) {
  return dbRun(paths, (db) => {
    requireEnabled(paths);
    const current = detail(db, workId, paths);
    expectVersion(current, expectedVersion);
    const latest = latestIntent(db, workId);
    if (latest && ['triage', 'planner'].includes(latest.stage))
      throw new FactoryError(
        409,
        'Stop pending planning before refreshing context.',
      );
    const binding = readBinding(db, workId);
    if (!binding) throw new FactoryError(409, 'Start planning first.');
    binding.context = captureContext(current, paths);
    db.prepare(
      'UPDATE factory_planning_bindings SET record=? WHERE work_id=?',
    ).run(JSON.stringify(binding), workId);
    db.prepare(
      'INSERT INTO factory_audit (work_id,action,actor,created_at) VALUES (?,?,?,?)',
    ).run(
      workId,
      'planning-context-refreshed',
      'local-operator',
      binding.context.capturedAt,
    );
    return binding;
  });
}
export function getPlanningState(
  workId: string,
  paths = runtimePaths(),
): FactoryPlanningState {
  return dbRun(paths, (db) => {
    const current = detail(db, workId, paths);
    const binding = readBinding(db, workId),
      intent = latestIntent(db, workId);
    return {
      sessionId: binding?.sessionId ?? null,
      plannerStarted: !!db
        .prepare(
          "SELECT id FROM factory_planning_intents WHERE work_id=? AND json_extract(record, '$.submissionId') IS NOT NULL LIMIT 1",
        )
        .get(workId),
      contextCapturedAt: binding?.context.capturedAt ?? null,
      model: binding?.context.model ?? null,
      contextStale: !!binding && contextChanged(binding, current, paths),
      triage: intent?.triage ?? null,
      triageModel: intent?.triageModel ?? intent?.context.utilityModel ?? null,
      triageSubmissionId: intent?.triageSubmissionId ?? null,
      activity: !intent
        ? 'idle'
        : ['triage', 'planner'].includes(intent.stage)
          ? 'pending'
          : (intent.stage as 'completed' | 'failed'),
      error: intent?.error ?? null,
      submissionId: intent?.submissionId ?? null,
    };
  });
}
export function getBoundPlanningSession(
  sessionId: string,
  paths = runtimePaths(),
) {
  return dbRun(paths, (db) => {
    const binding = read(
      db,
      'SELECT record FROM factory_planning_bindings WHERE session_id=?',
      bindingSchema,
      sessionId,
    );
    if (!binding) throw new FactoryError(403, 'Unbound factory conversation.');
    return {
      binding,
      session: readFactoryPlannerSession(db, sessionId, binding.workId),
    };
  });
}
export function getPlanningIntent(id: string, paths = runtimePaths()) {
  return dbRun(paths, (db) => readIntent(db, id));
}
export function pendingPlanningIntents(
  paths = runtimePaths(),
  workId?: string,
) {
  return dbRun(paths, (db) =>
    db
      .prepare(
        workId === undefined
          ? 'SELECT record FROM factory_planning_intents'
          : 'SELECT record FROM factory_planning_intents WHERE work_id=?',
      )
      .all(...(workId === undefined ? [] : [workId]))
      .map((row) => v.parse(intentSchema, JSON.parse(String(row.record))))
      .filter((i) => ['triage', 'planner'].includes(i.stage)),
  );
}
export function updatePlanningIntent(
  id: string,
  update: (intent: PlanningIntent) => void,
  paths = runtimePaths(),
) {
  return dbRun(paths, (db) => {
    const intent = readIntent(db, id);
    update(intent);
    writeIntent(db, intent);
    return intent;
  });
}
export function authorizePlanningIntent(
  db: DatabaseSync,
  sessionId: string,
  intentId: string,
  stage: 'triage' | 'planner',
  paths: RuntimePaths,
) {
  requireEnabled(paths);
  const intent = readIntent(db, intentId),
    binding = readBinding(db, intent.workId);
  if (
    !binding ||
    binding.sessionId !== sessionId ||
    intent.sessionId !== sessionId ||
    intent.stage !== stage ||
    intent.abortRequested
  )
    throw new FactoryError(
      403,
      'Planning capability is no longer active for this task/session.',
    );
  readFactoryPlannerSession(db, sessionId, intent.workId);
  const current = detail(db, intent.workId, paths);
  if (['paused', 'closed', 'queued'].includes(current.work.lifecycle))
    throw new FactoryError(409, 'Task is not open for planning.');
  expectVersion(current, intent.snapshot.work.version);
  if (
    current.repoFingerprint !== intent.context.repoFingerprint ||
    current.source.version !== intent.context.sourceVersion
  )
    throw new FactoryError(409, 'Planning context is stale.');
  return intent;
}
export function proposeFactorySpec(
  sessionId: string,
  intentId: string,
  toolCallId: string,
  input: unknown,
  paths = runtimePaths(),
) {
  const data = v.parse(saveSpecSchema, input);
  return dbRun(paths, (db) => {
    const effectId = hashPlanning({ sessionId, toolCallId });
    const old = db
      .prepare(
        'SELECT record FROM factory_planning_effects WHERE id=? AND intent_id=?',
      )
      .get(effectId, intentId);
    if (old) {
      const effect = JSON.parse(String(old.record));
      if (effect.inputHash !== hashPlanning(data))
        throw new FactoryError(
          409,
          'Proposal retry differs from recorded input.',
        );
      return effect.result as { version: number; hash: string };
    }
    const intent = authorizePlanningIntent(
      db,
      sessionId,
      intentId,
      'planner',
      paths,
    );
    if (
      data.expectedVersion !== intent.snapshot.work.version ||
      data.expectedSpecVersion !== intent.snapshot.work.specVersion ||
      data.expectedRepoFingerprint !== intent.context.repoFingerprint
    )
      throw new FactoryError(
        409,
        'Proposal must use the revision bound to this request.',
      );
    const evidence = db
      .prepare('SELECT record FROM factory_planning_effects WHERE intent_id=?')
      .all(intent.id)
      .map((row) => JSON.parse(String(row.record)));
    if (
      data.spec.references.some(
        (r) =>
          r.commit !== intent.context.repoCommit ||
          !safeReference(r.path) ||
          !evidence.some((e) => e.path === r.path && e.commit === r.commit),
      )
    )
      throw new FactoryError(
        400,
        'Repository references must use bounded relative paths and the captured commit.',
      );
    const saved = saveSpecInTransaction(
      db,
      intent.workId,
      data,
      { kind: 'model', id: sessionId },
      paths,
    );
    const revision = saved.revisions.at(-1)!;
    const result = { version: revision.version, hash: revision.hash };
    db.prepare(
      'INSERT INTO factory_planning_effects (id,intent_id,record) VALUES (?,?,?)',
    ).run(
      effectId,
      intentId,
      JSON.stringify({ inputHash: hashPlanning(data), result }),
    );
    // A second proposal in this turn intentionally conflicts: one effective revision per request.
    return result;
  });
}
export function safeReference(path: string) {
  return (
    path.length < 500 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path
      .split('/')
      .some((p) => !p || p === '.' || p === '..' || p.startsWith('.'))
  );
}
export function recordTriage(
  sessionId: string,
  intentId: string,
  input: unknown,
  paths = runtimePaths(),
) {
  const result = v.parse(triageResultSchema, input);
  return dbRun(paths, (db) => {
    const retained = readIntent(db, intentId);
    if (retained.sessionId === sessionId && retained.triage) {
      if (hashPlanning(retained.triage) !== hashPlanning(result))
        throw new FactoryError(409, 'Triage is already recorded.');
      return retained.triage;
    }
    const intent = authorizePlanningIntent(
      db,
      sessionId,
      intentId,
      'triage',
      paths,
    );
    if (
      result.candidateIds.some(
        (id) => !intent.triageCandidates.some((c) => c.id === id),
      )
    )
      throw new FactoryError(400, 'Unknown duplicate candidate.');
    intent.triage = result;
    intent.triageModel = intent.context.utilityModel;
    writeIntent(db, intent);
    return result;
  });
}

/** Reusable post-admission triage entrypoint. Fingerprints ignore delivery ids,
 * so a replay or unchanged source cannot spend another classifier submission. */
export function prepareFactoryTriage(
  workId: string,
  paths = runtimePaths(),
  retry = false,
) {
  const current = dbRun(paths, (db) => detail(db, workId, paths));
  if (current.work.specVersion > 1 || current.work.lifecycle !== 'inbox')
    return null;
  const fingerprint = hashPlanning({
    title: current.source.title,
    body: current.source.body,
    repoId: current.work.repoId,
    repoFingerprint: current.repoFingerprint,
  });
  const requestKey = `triage:${fingerprint}${retry ? `:${randomUUID()}` : ''}`;
  const retained = dbRun(paths, (db) =>
    read(
      db,
      'SELECT record FROM factory_planning_intents WHERE work_id=? AND request_key=?',
      intentSchema,
      workId,
      requestKey,
    ),
  );
  if (retained) return retained;
  const pending = dbRun(paths, (db) => latestIntent(db, workId));
  if (pending && ['triage', 'planner'].includes(pending.stage)) return pending;
  return prepareFactoryPlanning(
    workId,
    {
      requestKey,
      expectedVersion: current.work.version,
      message: 'Classify this admitted source. Do not start planning.',
    },
    paths,
    true,
  );
}
