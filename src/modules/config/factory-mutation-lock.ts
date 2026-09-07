import { mkdirSync, realpathSync, rmdirSync } from 'node:fs';

/** Factory mutations fail closed under contention, including an abandoned lock.
 * No time-based stealing: a slow live writer must never lose its ownership. */
export function withFactoryMutationLock<T>(
  configPath: string,
  operation: () => T,
): T {
  const lockPath = `${realpathSync(configPath)}.factory-write.lock`;
  try {
    mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new Error(
        'Factory configuration is locked by another writer. Retry after it finishes. If the writer crashed, stop all Neondeck processes before removing config.json.factory-write.lock from the runtime home.',
      );
    }
    throw error;
  }
  let result: T;
  try {
    result = operation();
  } catch (error) {
    try {
      rmdirSync(lockPath);
    } catch {
      /* Preserve the original mutation error. */
    }
    throw error;
  }
  rmdirSync(lockPath);
  return result;
}
