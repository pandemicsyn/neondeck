import {
  getCodingRun,
  getCodingRunForWorktree,
  type CodingRunRecord,
} from '../coding-runs';
import type { RuntimePaths } from '../../runtime-home';
import { requireWorktree } from './store';
import type { WorktreeRecord } from './schemas';
import { WorktreeError } from './errors';
export type FactoryWorkspaceClaim = Pick<
  CodingRunRecord,
  'runId' | 'attemptId' | 'ownershipToken'
>;
export function codingWorktreeOwner(
  record: WorktreeRecord,
  paths: RuntimePaths,
) {
  return (
    getCodingRunForWorktree(record.id, paths) ??
    (record.owningWorkflowRunId
      ? getCodingRun(record.owningWorkflowRunId, paths)
      : null)
  );
}
export function assertFactoryClaim(
  run: CodingRunRecord,
  claim: FactoryWorkspaceClaim | undefined,
) {
  if (
    !claim ||
    claim.runId !== run.runId ||
    claim.attemptId !== run.attemptId ||
    claim.ownershipToken !== run.ownershipToken
  )
    throw new WorktreeError(
      'FACTORY_OWNED',
      'Factory workspace is retained and cannot be mutated by generic operations.',
    );
}
export function guardCodingWorktree(
  record: WorktreeRecord,
  paths: RuntimePaths,
  claim?: FactoryWorkspaceClaim,
) {
  const run = codingWorktreeOwner(record, paths);
  if (run) assertFactoryClaim(run, claim);
}
export function guardCodingWorktreeId(id: string, paths: RuntimePaths) {
  guardCodingWorktree(requireWorktree(id, paths), paths);
}
