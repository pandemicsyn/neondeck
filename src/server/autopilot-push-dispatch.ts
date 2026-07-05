import { invoke, type WorkflowDefinition } from '@flue/runtime';
import { asJsonValue } from '../lib/action-result';
import { addWorkflowSummary } from '../modules/app-state';
import {
  approvePreparedDiffPush,
  type PreparedDiffActionResult,
  type PreparedDiffRecord,
} from '../modules/prepared-diffs';
import {
  type RuntimePaths,
  parseAppConfig,
  readRuntimeJson,
  runtimePaths,
} from '../runtime-home';

type PushOnApprovalMode = 'push' | 'verify-then-push' | 'off';
type DispatchWorkflowName = 'push-pr-autofix' | 'verify-pr-worktree';
type WorkflowReceipt = { runId: string };

type ApprovalDispatchDependencies = {
  invokeWorkflow?: (
    workflow: DispatchWorkflowName,
    input: Record<string, unknown>,
  ) => Promise<WorkflowReceipt>;
};

export async function approvePreparedDiffPushWithDispatch(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
  dependencies: ApprovalDispatchDependencies = {},
): Promise<PreparedDiffActionResult> {
  const approval = await approvePreparedDiffPush(rawInput, paths);
  if (!approval.ok || !approval.preparedDiff) return approval;
  return dispatchApprovedPreparedDiffPush(approval, paths, dependencies);
}

async function dispatchApprovedPreparedDiffPush(
  approval: PreparedDiffActionResult,
  paths: RuntimePaths,
  dependencies: ApprovalDispatchDependencies,
): Promise<PreparedDiffActionResult> {
  const preparedDiff = approval.preparedDiff;
  if (!preparedDiff) return approval;

  const mode = await readPushOnApprovalMode(paths);
  if (mode === 'off') {
    return withDispatchData(
      approval,
      {
        mode,
        status: 'off',
        message: 'Push dispatch is disabled by autopilot.pushOnApproval=off.',
      },
      'Recorded prepared diff push approval. Push dispatch is disabled by autopilot.pushOnApproval=off.',
    );
  }

  const dispatch =
    mode === 'verify-then-push' && preparedDiff.verificationStatus !== 'passed'
      ? verifyDispatch(preparedDiff)
      : pushDispatch(preparedDiff);
  const invokeWorkflow = dependencies.invokeWorkflow ?? invokeAutopilotWorkflow;
  const receipt = await invokeWorkflow(dispatch.workflow, dispatch.input);
  const workflowSummary = await addWorkflowSummary(
    {
      workflow: dispatch.workflow.replaceAll('-', '_'),
      runId: receipt.runId,
      status: 'pending',
      summary: {
        event: 'prepared_diff_push_approval_dispatch',
        mode,
        approvalId: approval.approvals?.[0]?.id ?? null,
        preparedDiffId: preparedDiff.id,
        worktreeId: preparedDiff.worktreeId,
        repoId: preparedDiff.repoId,
        repoFullName: preparedDiff.repoFullName,
        prNumber: preparedDiff.prNumber,
        workflow: dispatch.workflow,
        input: dispatch.input,
        dispatchedAt: new Date().toISOString(),
      },
    },
    paths,
  );

  return withDispatchData(
    approval,
    {
      mode,
      status: 'dispatched',
      workflow: dispatch.workflow,
      runId: receipt.runId,
      workflowSummaryId: workflowSummary.id,
      message: dispatch.message,
    },
    dispatch.message,
  );
}

function pushDispatch(preparedDiff: PreparedDiffRecord) {
  return {
    workflow: 'push-pr-autofix' as const,
    input: {
      preparedDiffId: preparedDiff.id,
      lockOwner: 'approval_push_pr_autofix',
    },
    message: `Approved prepared diff ${preparedDiff.id}; dispatched push-pr-autofix workflow.`,
  };
}

function verifyDispatch(preparedDiff: PreparedDiffRecord) {
  return {
    workflow: 'verify-pr-worktree' as const,
    input: {
      worktreeId: preparedDiff.worktreeId,
      lockOwner: 'approval_verify_pr_worktree',
    },
    message: `Approved prepared diff ${preparedDiff.id}; push is waiting on verification and verify-pr-worktree was dispatched.`,
  };
}

async function readPushOnApprovalMode(
  paths: RuntimePaths,
): Promise<PushOnApprovalMode> {
  const config = await readRuntimeJson(paths.config, parseAppConfig);
  const value = config.autopilot?.pushOnApproval;
  return value === 'push' || value === 'off' ? value : 'verify-then-push';
}

async function invokeAutopilotWorkflow(
  workflow: DispatchWorkflowName,
  input: Record<string, unknown>,
) {
  if (workflow === 'push-pr-autofix') {
    const module = await import('../workflows/push-pr-autofix');
    return invokeWorkflow(module.default, { input });
  }
  const module = await import('../workflows/verify-pr-worktree');
  return invokeWorkflow(module.default, { input });
}

async function invokeWorkflow(
  workflow: WorkflowDefinition,
  request: { input: Record<string, unknown> },
) {
  return invoke(workflow, request);
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
