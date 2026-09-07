import { createHmac, randomBytes } from 'node:crypto';
import * as v from 'valibot';
import {
  factoryDiagnosticExportSchema,
  type FactoryHealth,
  type FactoryTimeline,
} from '../../../shared/factory-diagnostics';
import type { FactoryDiagnostic } from '../../../shared/factory-observability';

export function createDiagnosticExport(
  health: FactoryHealth,
  timeline: FactoryTimeline,
  diagnostics: { records: FactoryDiagnostic[]; nextBefore: number | null },
) {
  const salt = randomBytes(32);
  // The same identity maps consistently across timeline, trace and correlation fields.
  // A fresh unexported key prevents dictionary reversal of private operator IDs.
  const token = (id: string) =>
    `id:${createHmac('sha256', salt).update(id).digest('hex').slice(0, 24)}`;
  const correlation = (input: FactoryDiagnostic['correlation']) =>
    Object.fromEntries(
      Object.entries(input)
        .filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        )
        .map(([key, value]) => [key, token(value)]),
    );
  return v.parse(factoryDiagnosticExportSchema, {
    schemaVersion: 1,
    generatedAt: health.generatedAt,
    workId: token(timeline.workId),
    notice:
      'Local diagnostic summary. IDs are pseudonymized; no raw logs, prompts, paths, credentials or actor identities. Authority records and retained diagnostic spans are distinct; this is not a complete execution trace.',
    health: {
      status: health.status,
      truncated: health.truncated,
      workers: health.workers.map((w) => ({
        worker: w.worker,
        status: w.status,
        lastSuccessAt: w.lastSuccessAt,
        nextTickAt: w.nextTickAt,
        consecutiveFailures: w.consecutiveFailures,
      })),
      tasks: health.tasks.map((t) => ({
        workId: token(t.workId),
        pendingAgeMs: t.pendingAgeMs,
        remainingExecutionMs: t.budgets.length
          ? t.budgets.reduce((sum, b) => sum + b.remainingExecutionMs, 0)
          : null,
        repairsRemaining: t.budgets.length
          ? t.budgets.reduce((sum, b) => sum + b.repairsRemaining, 0)
          : null,
        unresolvedEffectCount: t.unresolvedEffects.length,
        truncated: t.truncated,
      })),
    },
    timeline: {
      entries: timeline.entries.map((e) => {
        const { specVersion, specHash, ...ids } = e.correlation;
        return {
          id: token(e.id),
          kind: e.kind,
          recordType: e.recordType,
          occurredAt: e.occurredAt,
          correlation: correlation(ids),
          specVersion: specVersion ?? null,
          specHash: specHash ?? null,
          evidenceCount: e.evidenceRefs.length,
        };
      }),
      truncated: timeline.coverage.truncated || timeline.nextCursor !== null,
    },
    diagnostics: {
      spans: diagnostics.records.map((s) => ({
        id: token(s.id),
        traceId: token(s.traceId),
        parentSpanId: s.parentSpanId === null ? null : token(s.parentSpanId),
        operation: s.operation,
        correlation: correlation(s.correlation),
        error:
          s.error === null
            ? null
            : { class: s.error.class, code: s.error.code },
        kind: s.kind,
        startedAt: s.startedAt,
        finishedAt: s.finishedAt,
        durationMs: s.durationMs,
        outcome: s.outcome,
      })),
      truncated: diagnostics.nextBefore !== null,
    },
  });
}
export function serializeDiagnosticExport(input: unknown) {
  return `${JSON.stringify(v.parse(factoryDiagnosticExportSchema, input), null, 2)}\n`;
}
