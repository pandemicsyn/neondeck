import { loadNeondeckEnv } from '../modules/runtime';
import type { RuntimePaths } from '../runtime-home';
import type { GlobalOptions } from './types';
import { runtimeHomeModule } from './modules';
import { expandHome } from './prompts';

export async function pathsFromOptions(options: GlobalOptions) {
  const { runtimePaths } = await runtimeHomeModule();
  return runtimePaths(options.home ? expandHome(options.home) : undefined);
}

export function loadEnvForPaths(
  paths: RuntimePaths,
  options: { includeDevFallback?: boolean; overwrite?: boolean } = {},
) {
  return loadNeondeckEnv(paths, options);
}

export function parseWatchTarget(value: string | undefined) {
  if (value === 'checks' || value === 'merged' || value === 'prod')
    return value;
  throw new Error('--until must be checks, merged, or prod');
}

export function parseOptionalIntervalSeconds(value: string | undefined) {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error('--interval must be an integer >= 60');
  }
  const seconds = Number(trimmed);
  if (!Number.isSafeInteger(seconds) || seconds < 60) {
    throw new Error('--interval must be an integer >= 60');
  }
  return seconds;
}

export function parseOptionalLimit(value: string | undefined) {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error('--limit must be an integer from 1 to 100');
  }
  const limit = Number(trimmed);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('--limit must be an integer from 1 to 100');
  }
  return limit;
}

export function parseCandidateStatus(value: string | undefined) {
  if (value === undefined) return undefined;
  if (
    value === 'proposed' ||
    value === 'applied' ||
    value === 'rejected' ||
    value === 'archived'
  ) {
    return value;
  }
  throw new Error('--status must be proposed, applied, rejected, or archived');
}

export function parseCandidateTarget(value: string | undefined) {
  if (value === undefined) return undefined;
  if (value === 'memory' || value === 'skill') return value;
  throw new Error('--target must be memory or skill');
}
