import { FlueError } from '@flue/runtime';

export function isTransientFlueRuntimeFailure(error: unknown) {
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
    if (
      typeof current === 'object' &&
      !Array.isArray(current) &&
      (current as Record<string, unknown>).type === 'runtime_unavailable'
    ) {
      return true;
    }
    current = current instanceof Error ? current.cause : undefined;
  }

  return false;
}
