import type { DeliveryPipeline } from '../../../shared/factory-delivery';
import type { RuntimePaths } from '../../runtime-home';
import { cleanupWorktrees, listWorktrees } from '../worktrees';

/** Keep all source/failed/uncertain work. The worktree service independently
 * revalidates terminal publication, 24h grace, writer death, head and cleanliness. */
export async function cleanupFactoryDelivery(
  pipeline: DeliveryPipeline,
  paths: RuntimePaths,
) {
  if (
    !['merged', 'closed'].includes(pipeline.outcome ?? '') ||
    !pipeline.coordinator.terminalObservedAt ||
    Date.now() - Date.parse(pipeline.coordinator.terminalObservedAt) < 86400000
  )
    return;
  const snapshot = await listWorktrees(paths);
  for (const worktree of snapshot.worktrees) {
    if (
      worktree.owningWorkflowRunId !==
        `factory-delivery:${pipeline.pipelineId}` ||
      worktree.lifecycleStatus === 'deleted'
    )
      continue;
    await cleanupWorktrees({ worktreeId: worktree.id }, paths, {
      pipelineId: pipeline.pipelineId,
      expectedVersion: pipeline.version,
    });
  }
}
