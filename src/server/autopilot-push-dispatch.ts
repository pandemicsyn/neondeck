import { invoke, type WorkflowDefinition } from '@flue/runtime';
import { asJsonValue } from '../lib/action-result';
import { addNotification, addWorkflowSummary } from '../modules/app-state';
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
type DispatchWorkflowName = 'push-pr-autofix' | 'verify-then-push-pr-autofix';
type WorkflowReceipt = { runId: string };

type ApprovalDispatchDependencies = {
  invokeWorkflow?: (
    workflow: DispatchWorkflowName,
    input: Record<string, unknown>,
  ) => Promise<WorkflowReceipt>;
};
type DispatchPlan =
  ReturnType<typeof pushDispatch> | ReturnType<typeof verifyThenPushDispatch>;

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
      ? verifyThenPushDispatch(preparedDiff)
      : pushDispatch(preparedDiff);
  const invokeWorkflow = dependencies.invokeWorkflow ?? invokeAutopilotWorkflow;
  try {
    process.env.NEONDECK_HOME = paths.home;
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
  } catch (error) {
    const message = errorMessage(error);
    await recordDispatchFailure(preparedDiff, mode, dispatch, message, paths);
    return {
      ...withDispatchData(
        approval,
        {
          mode,
          status: 'dispatch-failed',
          workflow: dispatch.workflow,
          message,
        },
        `Recorded prepared diff push approval, but workflow dispatch failed: ${message}`,
      ),
      requires: ['workflowDispatch'],
      errors: [message],
    };
  }
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

function verifyThenPushDispatch(preparedDiff: PreparedDiffRecord) {
  return {
    workflow: 'verify-then-push-pr-autofix' as const,
    input: {
      preparedDiffId: preparedDiff.id,
      worktreeId: preparedDiff.worktreeId,
    },
    message: `Approved prepared diff ${preparedDiff.id}; dispatched verify-then-push-pr-autofix workflow.`,
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
  const module = await import('../workflows/verify-then-push-pr-autofix');
  return invokeWorkflow(module.default, { input });
}

async function recordDispatchFailure(
  preparedDiff: PreparedDiffRecord,
  mode: PushOnApprovalMode,
  dispatch: DispatchPlan,
  error: string,
  paths: RuntimePaths,
) {
  await addWorkflowSummary(
    {
      workflow: dispatch.workflow.replaceAll('-', '_'),
      status: 'failed',
      summary: {
        event: 'prepared_diff_push_approval_dispatch',
        mode,
        preparedDiffId: preparedDiff.id,
        worktreeId: preparedDiff.worktreeId,
        repoId: preparedDiff.repoId,
        repoFullName: preparedDiff.repoFullName,
        prNumber: preparedDiff.prNumber,
        workflow: dispatch.workflow,
        input: dispatch.input,
        error,
        dispatchedAt: new Date().toISOString(),
      },
    },
    paths,
  ).catch(() => undefined);
  await addNotification(
    {
      level: 'attention',
      title: 'Push dispatch failed',
      message: `Prepared diff ${preparedDiff.id} was approved, but workflow dispatch failed: ${error}`,
      source: 'autopilot',
      sourceId: `prepared-diff:${preparedDiff.id}:push-dispatch-failed`,
      data: {
        preparedDiffId: preparedDiff.id,
        worktreeId: preparedDiff.worktreeId,
        workflow: dispatch.workflow,
        error,
      },
    },
    paths,
  ).catch(() => undefined);
}

async function invokeWorkflow(
  workflow: WorkflowDefinition,
  request: { input: Record<string, unknown> },
) {
  return invoke(workflow, request);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
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
