import {
  getActiveCodingRun,
  updateCodingRun,
  publishLocalCancellation,
  type CodingRunRecord,
} from '../coding-runs';
import type { RuntimePaths } from '../../runtime-home';
import { codingHandle } from './coding-handle';
import { assertCodingAuthoritySnapshot } from './coding-context';
function fence(
  paths: RuntimePaths,
  shouldCancel: (run: CodingRunRecord) => boolean,
) {
  let run = getActiveCodingRun(paths);
  if (!run || (!run.cancelRequestedAt && !shouldCancel(run))) return;
  if (!run.cancelRequestedAt)
    run = updateCodingRun(
      {
        runId: run.runId,
        attemptId: run.attemptId,
        ownershipToken: run.ownershipToken,
        expectedVersion: run.version,
        action: {
          type: 'cancel',
          reason:
            'Factory authority changed; execution cancellation requested.',
        },
      },
      paths,
    );
  // DB intent survives any subsequent host I/O failure. The synchronous host gate
  // orders revocation against launch authorization; uncertainty throws with the
  // reservation intact. Repeated invalidation/recovery can redeliver the intent.
  if (run.host) publishLocalCancellation(codingHandle(run, paths));
}
export function fenceInvalidFactoryCoding(paths: RuntimePaths) {
  fence(paths, (run) => {
    try {
      assertCodingAuthoritySnapshot(run.snapshot, paths);
      return false;
    } catch {
      return true;
    }
  });
}
export function cancelActiveFactoryCoding(paths: RuntimePaths) {
  fence(paths, () => true);
}
