import { createHash } from 'node:crypto';
import * as v from 'valibot';
import {
  factoryTimelineEntrySchema,
  factoryTimelineQuerySchema,
  factoryTimelineSchema,
  type FactoryTimelineEntry,
} from '../../../shared/factory-diagnostics';
import type { DeliveryRevision } from '../../../shared/factory-delivery';
import { DiagnosticsError, sourceLimit, type TaskRecords } from './records';
const projectionLimit = 2000;
export function projectTimeline(records: TaskRecords) {
  const entries: FactoryTimelineEntry[] = [];
  let overflow = false;
  function add(
    kind: FactoryTimelineEntry['kind'],
    id: string,
    occurredAt: string | null,
    summary: string,
    rest: Partial<FactoryTimelineEntry> = {},
  ) {
    if (entries.length === projectionLimit) {
      overflow = true;
      return;
    }
    entries.push(
      v.parse(factoryTimelineEntrySchema, {
        id,
        kind,
        recordType: 'record',
        occurredAt,
        timeBasis: occurredAt === null ? 'unknown' : 'recorded',
        actor: null,
        summary,
        correlation: { workItemId: records.work.id },
        revision: null,
        evidenceRefs: [],
        ...rest,
      }),
    );
  }
  const base = { workItemId: records.work.id };
  add(
    'task',
    `task:${records.work.id}`,
    records.work.createdAt,
    'Task created.',
  );
  for (const r of records.revisions)
    add(
      'spec',
      `spec:${r.workId}:${r.version}`,
      r.createdAt,
      `Specification version ${r.version} recorded.`,
      {
        actor: { kind: r.authorKind, id: r.actor },
        correlation: { ...base, specVersion: r.version, specHash: r.hash },
      },
    );
  for (const r of records.releases) {
    const correlation = {
      ...base,
      releaseId: r.id,
      specVersion: r.specVersion,
      specHash: r.specHash,
    };
    add(
      'release',
      `release:${r.id}`,
      r.createdAt,
      'Exact specification released by a human.',
      { actor: { kind: 'human', id: r.actor }, correlation },
    );
    if (r.withdrawnAt)
      add(
        'withdrawal',
        `withdrawal:${r.id}`,
        r.withdrawnAt,
        'Release withdrawn. Actor not recorded on release.',
        { correlation },
      );
  }
  for (const r of records.audit)
    add('audit', `audit:${r.id}`, r.createdAt, `Recorded action: ${r.action}`, {
      recordType: 'audit',
      actor: { kind: 'unknown', id: r.actor },
    });
  for (const r of records.planning) {
    add(
      'planning',
      `planning:${r.id}`,
      r.createdAt,
      `Planning request created; current stage: ${r.stage}.`,
      {
        correlation: {
          ...base,
          ...(r.submissionId ? { submissionId: r.submissionId } : {}),
        },
      },
    );
    if (r.triageSubmissionId)
      add(
        'planning',
        `triage-submission:${r.id}`,
        null,
        'Retained triage submission binding; submission time not recorded.',
        { correlation: { ...base, submissionId: r.triageSubmissionId } },
      );
  }
  for (const r of records.receipts)
    add(
      'planning-receipt',
      `planning-receipt:${r.id}`,
      null,
      `Retained ${r.effect.kind} receipt; receipt time not recorded.`,
      {
        correlation: {
          ...base,
          effectId: r.id,
          ...(r.effect.kind === 'proposal'
            ? {
                specVersion: r.effect.result.version,
                specHash: r.effect.result.hash,
              }
            : {}),
        },
        evidenceRefs: [r.id],
      },
    );
  for (const e of records.writeback) {
    const correlation = { ...base, effectId: e.id, specVersion: e.specVersion };
    add(
      'effect',
      `writeback-reserved:${e.id}`,
      e.createdAt,
      `GitHub ${e.kind} writeback reserved.`,
      { correlation },
    );
    add(
      'effect',
      `writeback-state:${e.id}`,
      null,
      `GitHub ${e.kind} writeback current state: ${e.state}; transition time not recorded.`,
      {
        correlation,
        actor:
          e.remoteId && e.author ? { kind: 'unknown', id: e.author } : null,
        evidenceRefs: e.remoteId ? [`github-comment:${e.remoteId}`] : [],
      },
    );
  }
  for (const r of records.events) {
    const run = records.runs.find((run) => run.runId === r.runId);
    add(
      'coding',
      `coding-event:${r.sequence}`,
      r.createdAt,
      `Coding ${r.type}; status ${r.status}; version ${r.version}.`,
      {
        correlation: {
          ...base,
          runId: r.runId,
          ...(run
            ? {
                attemptId: run.attemptId,
                releaseId: run.snapshot.releaseId,
                specVersion: run.snapshot.specVersion,
                specHash: run.snapshot.specHash,
              }
            : {}),
        },
      },
    );
  }
  for (const d of records.deliveries) {
    const bound = (revision: DeliveryRevision) => ({
      revision,
      correlation: {
        ...base,
        deliveryId: d.pipelineId,
        runId: revision.runId,
        attemptId: revision.attemptId,
        releaseId: revision.releaseId,
        specVersion: revision.specVersion,
        specHash: revision.specHash,
      },
    });
    add(
      'authorization',
      `authorization:${d.authorization.id}`,
      d.authorization.authorizedAt,
      'Human delivery authorization recorded.',
      {
        ...bound(d.authorization.revision),
        actor: { kind: 'human', id: d.authorization.authorizedBy },
      },
    );
    for (const e of d.evidence)
      add(
        e.kind,
        `evidence:${d.pipelineId}:${e.id}`,
        null,
        `${e.kind} result: ${e.result}; evidence time not recorded.`,
        {
          ...bound(e.revision),
          correlation: {
            ...bound(e.revision).correlation,
            effectId: e.effectId,
          },
          evidenceRefs: [e.evidenceRef],
        },
      );
    for (const a of d.progress.assessments) {
      add(
        'judge',
        `judge-reserved:${a.assessmentId}`,
        a.reservedAt,
        'Progress assessment reserved.',
        {
          ...bound(a.revision),
          correlation: {
            ...bound(a.revision).correlation,
            ...(a.submissionId ? { submissionId: a.submissionId } : {}),
          },
          evidenceRefs: a.evidenceRefs,
        },
      );
      if (a.state === 'settled')
        add(
          'judge',
          `judge-result:${a.assessmentId}`,
          a.completedAt,
          `Progress assessment settled${a.result ? `: ${a.result.decision}` : ''}.`,
          {
            ...bound(a.revision),
            correlation: {
              ...bound(a.revision).correlation,
              ...(a.submissionId ? { submissionId: a.submissionId } : {}),
            },
            evidenceRefs: a.resultId ? [a.resultId] : [],
          },
        );
    }
    for (const r of d.repairs)
      add(
        'repair',
        `repair:${d.pipelineId}:${r.runId}`,
        null,
        `Repair current status: ${r.status}; reservation time not recorded.`,
        {
          ...bound(r.fromRevision),
          repairTarget: { runId: r.runId, attemptId: r.attemptId },
        },
      );
    for (const e of d.effects)
      add(
        'effect',
        `effect:${d.pipelineId}:${e.id}`,
        null,
        `${e.kind} effect current state: ${e.state}; transition time not recorded.`,
        {
          ...bound(e.revision),
          correlation: { ...bound(e.revision).correlation, effectId: e.id },
          evidenceRefs: e.receiptRef ? [e.receiptRef] : [],
        },
      );
    if (d.outcome)
      add(
        'outcome',
        `outcome:${d.pipelineId}`,
        d.coordinator.terminalObservedAt,
        `Delivery outcome: ${d.outcome}.`,
        {
          ...bound(d.revision),
          evidenceRefs: d.outcomeRef ? [d.outcomeRef] : [],
        },
      );
  }
  entries.sort((a, b) => {
    const ta = a.occurredAt === null ? Infinity : Date.parse(a.occurredAt),
      tb = b.occurredAt === null ? Infinity : Date.parse(b.occurredAt);
    return ta < tb ? -1 : ta > tb ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return { entries, truncated: records.truncated || overflow };
}
const cursorSchema = v.strictObject({
  version: v.literal(1),
  workId: v.string(),
  fingerprint: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  offset: v.pipe(
    v.number(),
    v.safeInteger(),
    v.minValue(0),
    v.maxValue(projectionLimit),
  ),
});
export function timelinePage(records: TaskRecords, input: unknown) {
  const query = v.parse(factoryTimelineQuerySchema, input);
  const projection = projectTimeline(records);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(projection))
    .digest('hex');
  let offset = 0;
  if (query.cursor) {
    let cursor: v.InferOutput<typeof cursorSchema>;
    try {
      cursor = v.parse(
        cursorSchema,
        JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')),
      );
    } catch {
      throw new DiagnosticsError(400, 'Invalid timeline cursor.');
    }
    if (cursor.workId !== records.work.id)
      throw new DiagnosticsError(400, 'Cursor belongs to another task.');
    if (cursor.fingerprint !== fingerprint)
      throw new DiagnosticsError(
        409,
        'Task history changed. Refresh the timeline from its first page.',
      );
    offset = cursor.offset;
  }
  const next = offset + query.limit;
  return v.parse(factoryTimelineSchema, {
    workId: records.work.id,
    entries: projection.entries.slice(offset, next),
    nextCursor:
      next < projection.entries.length
        ? Buffer.from(
            JSON.stringify({
              version: 1,
              workId: records.work.id,
              fingerprint,
              offset: next,
            }),
          ).toString('base64url')
        : null,
    coverage: {
      bounded: true,
      limit: sourceLimit,
      truncated: projection.truncated,
      note: 'Latest 200 records per source; up to 2,000 projected entries. Undated records follow recorded timestamps. Mutable receipts show current state, not invented audit history. Diagnostic spans are separate.',
    },
  });
}
