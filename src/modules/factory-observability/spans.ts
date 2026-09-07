import { logFactoryDiagnostic, logFactoryStorageFailure } from './logger';
import * as v from 'valibot';
import {
  factoryCorrelationSchema,
  factoryDiagnosticSchema,
} from '../../../shared/factory-observability';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { RuntimePaths } from '../../runtime-home';
import type {
  FactoryCorrelation,
  FactoryDiagnosticOperation,
  FactoryDiagnostic,
} from '../../../shared/factory-observability';
import { appendDiagnostic } from './store';
import { classifyFactoryError } from './errors';
const degraded = new Set<string>();
export const diagnosticsDegraded = (paths: RuntimePaths) =>
  degraded.has(paths.neondeckDatabase);
export function markDiagnosticsDegraded(paths: RuntimePaths) {
  if (degraded.size >= 64) degraded.delete(degraded.values().next().value!);
  degraded.add(paths.neondeckDatabase);
  bestEffort(() => logFactoryStorageFailure(paths));
}
const context = new AsyncLocalStorage<{
  traceId: string;
  spanId: string;
  correlation: FactoryCorrelation;
}>();
/** Diagnostics must never prevent admission or replace the original result/error. */
export function bestEffort(operation: () => void) {
  try {
    operation();
    return true;
  } catch {
    return false;
  }
}
export function startFactorySpan(
  paths: RuntimePaths,
  operation: FactoryDiagnosticOperation,
  correlation: FactoryCorrelation = {},
  kind: FactoryDiagnostic['kind'] = 'phase',
) {
  const parent = context.getStore();
  const span = {
    traceId: parent?.traceId ?? randomUUID(),
    spanId: randomUUID(),
    correlation: { ...parent?.correlation, ...correlation },
  };
  const startedAt = new Date().toISOString();
  const start = performance.now();
  let ended = false;
  return {
    context: span,
    finish(error?: unknown) {
      if (ended) return;
      ended = true;
      let record: FactoryDiagnostic;
      try {
        record = v.parse(factoryDiagnosticSchema, {
          sequence: 0,
          id: span.spanId,
          traceId: span.traceId,
          parentSpanId: parent?.spanId ?? null,
          operation,
          kind,
          startedAt,
          finishedAt: new Date().toISOString(),
          durationMs: Math.max(0, performance.now() - start),
          outcome: error === undefined ? 'success' : 'failure',
          correlation: span.correlation,
          error: error === undefined ? null : classifyFactoryError(error),
        });
      } catch {
        markDiagnosticsDegraded(paths);
        return;
      }
      bestEffort(() => logFactoryDiagnostic(paths, record));
      if (!bestEffort(() => appendDiagnostic(paths, record)))
        markDiagnosticsDegraded(paths);
    },
  };
}
export async function withFactorySpan<T>(
  paths: RuntimePaths,
  operation: FactoryDiagnosticOperation,
  correlation: FactoryCorrelation,
  run: (span: ReturnType<typeof startFactorySpan>) => Promise<T>,
  kind: FactoryDiagnostic['kind'] = 'external',
): Promise<T> {
  const span = startFactorySpan(paths, operation, correlation, kind);
  return context.run(span.context, async () => {
    try {
      const result = await run(span);
      span.finish();
      return result;
    } catch (error) {
      span.finish(error ?? new Error());
      throw error;
    }
  });
}

/** Bind a receipt only after its authoritative submission ID is known. No event payload capture. */
export function bindFactorySpanCorrelation(input: FactoryCorrelation) {
  bestEffort(() => {
    const current = context.getStore();
    if (current)
      Object.assign(
        current.correlation,
        v.parse(factoryCorrelationSchema, input),
      );
  });
}
