import { FlueError } from '@flue/runtime';
import * as v from 'valibot';

const runtimeUnavailableErrorSchema = v.looseObject({
  type: v.literal('runtime_unavailable'),
});

export function isTransientFlueRuntimeFailure<TError>(error: TError) {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (
      current instanceof FlueError &&
      current.type === 'runtime_unavailable'
    ) {
      return true;
    }
    if (v.safeParse(runtimeUnavailableErrorSchema, current).success) {
      return true;
    }
    current = current instanceof Error ? current.cause : undefined;
  }

  return false;
}
