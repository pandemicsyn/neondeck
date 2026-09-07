import type { FactoryDiagnostic } from '../../../shared/factory-observability';
import type { RuntimePaths } from '../../runtime-home';
const states = new Map<string, { failure: string | null; emittedAt: number }>();
function keep(
  key: string,
  value: { failure: string | null; emittedAt: number },
) {
  if (states.size >= 256 && !states.has(key))
    states.delete(states.keys().next().value!);
  states.set(key, value);
}
/** Fixed event fields only. A repeated failure is silent; changes are rate-limited. */
export function logFactoryDiagnostic(
  paths: RuntimePaths,
  record: FactoryDiagnostic,
) {
  const key = `${paths.neondeckDatabase}:${record.operation}`;
  const previous = states.get(key);
  const failure = record.error?.code ?? null;
  if (!failure && !previous?.failure) return;
  if (failure === previous?.failure) return;
  if (previous && Date.now() - previous.emittedAt < 60000) return;
  keep(key, { failure, emittedAt: Date.now() });
  const payload = {
    event: failure ? 'factory.operation.failed' : 'factory.operation.recovered',
    operation: record.operation,
    spanId: record.id,
    traceId: record.traceId,
    correlation: record.correlation,
    error: record.error,
  };
  if (failure) console.warn(JSON.stringify(payload));
  else console.info(JSON.stringify(payload));
}
export function logFactoryStorageFailure(paths: RuntimePaths) {
  const key = `${paths.neondeckDatabase}:storage`;
  const previous = states.get(key);
  if (previous && Date.now() - previous.emittedAt < 60000) return;
  keep(key, { failure: 'DIAGNOSTIC_STORAGE_FAILED', emittedAt: Date.now() });
  console.warn(
    JSON.stringify({
      event: 'factory.diagnostics.degraded',
      code: 'DIAGNOSTIC_STORAGE_FAILED',
    }),
  );
}
