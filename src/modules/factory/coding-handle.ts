import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { CodingRunRecord } from '../coding-runs';
import type { RuntimePaths } from '../../runtime-home';
export function codingHandle(run: CodingRunRecord, paths: RuntimePaths) {
  const directory = join(
    realpathSync(paths.home),
    'coding-attempts',
    run.attemptId,
  );
  if (run.host?.hostId !== 'local-codex' || run.host.jobId !== directory)
    throw new Error('Stored local host identity does not match attempt.');
  return {
    directory,
    attemptToken: createHash('sha256').update(run.ownershipToken).digest('hex'),
  };
}
