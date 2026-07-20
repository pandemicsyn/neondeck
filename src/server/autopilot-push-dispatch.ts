import { asJsonValue } from '../lib/action-result';
import { approvePreparedDiffPushWithPolicy } from '../modules/autopilot';
import { type PreparedDiffActionResult } from '../modules/prepared-diffs';
import { runtimePaths, type RuntimePaths } from '../runtime-home';

type ApprovalDispatchDependencies = {
  /** Kept for route compatibility; coordinator dispatch deliberately ignores it. */
  invokeWorkflow?: unknown;
};

export async function approvePreparedDiffPushWithDispatch(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
  dependencies: ApprovalDispatchDependencies = {},
): Promise<PreparedDiffActionResult> {
  void dependencies;
  const approval = await approvePreparedDiffPushWithPolicy(rawInput, paths);
  if (!approval.ok || !approval.preparedDiff) return approval;
  // The durable admission coordinator is the sole authority that reserves and
  // invokes a push stage. Approval only resolves the SHA/policy-bound record;
  // the next coordinator reconciliation observes that resolution and admits
  // exactly one push attempt.
  return withDispatchData(
    approval,
    {
      status: 'awaiting-coordinator',
      message:
        'Recorded the push approval. The Autopilot coordinator will admit the push stage.',
    },
    'Recorded prepared diff push approval; awaiting durable coordinator admission.',
  );
}

function withDispatchData(
  approval: PreparedDiffActionResult,
  dispatch: Record<string, unknown>,
  message: string,
): PreparedDiffActionResult {
  const existing =
    approval.data &&
    typeof approval.data === 'object' &&
    !Array.isArray(approval.data)
      ? approval.data
      : {};
  return {
    ...approval,
    message,
    data: asJsonValue({
      ...existing,
      pushApprovalDispatch: dispatch,
      dispatchedPushRunId:
        typeof dispatch.runId === 'string' ? dispatch.runId : null,
      workflowSummaryId:
        typeof dispatch.workflowSummaryId === 'string'
          ? dispatch.workflowSummaryId
          : null,
    }),
  };
}
