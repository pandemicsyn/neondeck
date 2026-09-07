import * as v from 'valibot';
import {
  factorySafeErrorSchema,
  type FactorySafeError,
} from '../../../shared/factory-observability';
/** Never serialize messages, arbitrary names/codes, stacks, causes or provider payloads. */
export function classifyFactoryError(error: unknown): FactorySafeError {
  try {
    return classify(error);
  } catch {
    return { class: 'unknown', code: 'UNKNOWN' };
  }
}
function classify(error: unknown): FactorySafeError {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return { class: 'abort', code: 'ABORTED' };
    if (error.name === 'TimeoutError')
      return { class: 'timeout', code: 'TIMEOUT' };
    if (error.name === 'ValiError')
      return { class: 'validation', code: 'VALIDATION' };
  }
  if (error && typeof error === 'object') {
    if (
      'outcome' in error &&
      'submissionId' in error &&
      (error.outcome === 'failed' || error.outcome === 'aborted')
    )
      return {
        class: 'model',
        code: error.outcome === 'failed' ? 'AGENT_FAILED' : 'AGENT_ABORTED',
      };
    if (
      'type' in error &&
      [
        'operation_failed',
        'submission_interrupted',
        'submission_retry_exhausted',
        'submission_timeout',
      ].includes(String(error.type))
    )
      return v.parse(factorySafeErrorSchema, {
        class: 'model',
        code: error.type,
      });
    if (
      'code' in error &&
      [
        'ENOENT',
        'EACCES',
        'EPERM',
        'ENOSPC',
        'ECONNRESET',
        'ECONNREFUSED',
        'ETIMEDOUT',
        'SQLITE_BUSY',
        'SQLITE_LOCKED',
      ].includes(String(error.code))
    )
      return v.parse(factorySafeErrorSchema, { class: 'io', code: error.code });
    if ('status' in error && typeof error.status === 'number') {
      const code =
        error.status >= 500 && error.status <= 599
          ? 'HTTP_5XX'
          : `HTTP_${error.status}`;
      const parsed = v.safeParse(factorySafeErrorSchema, {
        class: 'http',
        code,
      });
      if (parsed.success) return parsed.output;
    }
  }
  return { class: 'unknown', code: 'UNKNOWN' };
}
