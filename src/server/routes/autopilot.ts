import { Hono } from 'hono';
import {
  commentPrAutofixResult,
  fixPrCiFailure,
  fixPrReviewFeedback,
  preparePrWorktree,
  pushPrAutofix,
  triagePrEvent,
  verifyPrWorktree,
} from '../../modules/autopilot';
import {
  readAutopilotRecoveryOptions,
  runAutopilotRecoveryAction,
} from '../../modules/autopilot/recovery';
import {
  abandonPreparedDiff,
  approvePreparedDiffPush,
  listPreparedDiffs,
  openPreparedDiffWorktree,
  readPreparedDiffChangedFiles,
  readPreparedDiffFileDiff,
  readPreparedDiffApprovalRecord,
  readPreparedDiffSummary,
  requestPreparedDiffRevision,
  runPreparedDiffVerification,
} from '../../modules/prepared-diffs';
import { resolveExecutionApproval } from '../../modules/execution';
import type { RuntimePaths } from '../../runtime-home';
import {
  preparedDiffHttpStatus,
  queryBoolean,
  queryNumber,
  safeJsonBody,
  safeJsonObject,
} from '../http';
import { recordHandledPrApiResult } from '../learning-hooks';

export function createAutopilotRoutes(paths: RuntimePaths) {
  const routes = new Hono();

  routes.post('/autopilot/triage-pr-event', async (c) => {
    const result = await triagePrEvent(await safeJsonBody(c));
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/autopilot/prepare-pr-worktree', async (c) => {
    const result = await preparePrWorktree(await safeJsonBody(c), paths);
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/autopilot/fix-pr-ci-failure', async (c) => {
    const result = await fixPrCiFailure(await safeJsonBody(c), paths);
    recordHandledPrApiResult(paths, 'api:fix_pr_ci_failure', result);
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/autopilot/fix-pr-review-feedback', async (c) => {
    const result = await fixPrReviewFeedback(await safeJsonBody(c), paths);
    recordHandledPrApiResult(paths, 'api:fix_pr_review_feedback', result);
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/autopilot/comment-pr-autofix-result', async (c) => {
    const result = await commentPrAutofixResult(await safeJsonBody(c), paths);
    recordHandledPrApiResult(paths, 'api:comment_pr_autofix_result', result);
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/autopilot/approvals/:id/resolve', async (c) => {
    const input = await safeJsonObject(c);
    const decision = input.decision;
    if (decision !== 'approve' && decision !== 'deny') {
      return c.json(
        {
          ok: false,
          action: 'autopilot_approval_resolve',
          changed: false,
          message: 'Decision must be approve or deny.',
          errors: ['decision is required.'],
        },
        400,
      );
    }

    const executionResult = await resolveExecutionApproval(
      {
        id: c.req.param('id'),
        decision: decision === 'approve' ? 'allow-once' : 'deny',
        approverSurface: 'dashboard',
      },
      paths,
    );
    if (executionResult.ok || !approvalNotFound(executionResult.message)) {
      return c.json(executionResult, executionResult.ok ? 200 : 400);
    }

    const approval = readPreparedDiffApprovalRecord(c.req.param('id'), paths);
    if (!approval) {
      return c.json(
        {
          ok: false,
          action: 'autopilot_approval_resolve',
          changed: false,
          message: `Autopilot approval "${c.req.param('id')}" was not found.`,
          errors: ['approval not found.'],
        },
        404,
      );
    }

    const result =
      decision === 'approve'
        ? await approvePreparedDiffPush(
            {
              preparedDiffId: approval.preparedDiffId,
              confirm: true,
              reason: 'Approved from dashboard Autopilot panel.',
              approverSurface: 'dashboard',
            },
            paths,
          )
        : await requestPreparedDiffRevision(
            {
              preparedDiffId: approval.preparedDiffId,
              reason: 'Denied from dashboard Autopilot panel.',
              approverSurface: 'dashboard',
            },
            paths,
          );
    return c.json(result, preparedDiffHttpStatus(result));
  });

  routes.get('/prepared-diffs', async (c) => {
    const result = await listPreparedDiffs(
      {
        status: c.req.query('status') || undefined,
        includeTerminal: queryBoolean(c.req.query('includeTerminal')),
        repoId: c.req.query('repoId') || undefined,
      },
      paths,
    );
    return c.json(result, preparedDiffHttpStatus(result));
  });

  routes.get('/prepared-diffs/:id/summary', async (c) => {
    const result = await readPreparedDiffSummary(
      { preparedDiffId: c.req.param('id') },
      paths,
    );
    return c.json(result, preparedDiffHttpStatus(result));
  });

  routes.get('/prepared-diffs/:id/files', async (c) => {
    const result = await readPreparedDiffChangedFiles(
      { preparedDiffId: c.req.param('id') },
      paths,
    );
    return c.json(result, preparedDiffHttpStatus(result));
  });

  routes.get('/prepared-diffs/:id/files/diff', async (c) => {
    const result = await readPreparedDiffFileDiff(
      {
        preparedDiffId: c.req.param('id'),
        path: c.req.query('path'),
        maxPatchBytes: queryNumber(c.req.query('maxPatchBytes')),
      },
      paths,
    );
    return c.json(result, preparedDiffHttpStatus(result));
  });

  routes.post('/prepared-diffs/:id/approve-push', async (c) => {
    const result = await approvePreparedDiffPush(
      { ...(await safeJsonObject(c)), preparedDiffId: c.req.param('id') },
      paths,
    );
    return c.json(result, preparedDiffHttpStatus(result));
  });

  routes.post('/prepared-diffs/:id/request-revision', async (c) => {
    const result = await requestPreparedDiffRevision(
      { ...(await safeJsonObject(c)), preparedDiffId: c.req.param('id') },
      paths,
    );
    return c.json(result, preparedDiffHttpStatus(result));
  });

  routes.post('/prepared-diffs/:id/abandon', async (c) => {
    const result = await abandonPreparedDiff(
      { ...(await safeJsonObject(c)), preparedDiffId: c.req.param('id') },
      paths,
    );
    return c.json(result, preparedDiffHttpStatus(result));
  });

  routes.get('/prepared-diffs/:id/worktree-path', async (c) => {
    const result = await openPreparedDiffWorktree(
      { preparedDiffId: c.req.param('id') },
      paths,
    );
    return c.json(result, preparedDiffHttpStatus(result));
  });

  routes.post('/prepared-diffs/:id/verify', async (c) => {
    const result = await runPreparedDiffVerification(
      { ...(await safeJsonObject(c)), preparedDiffId: c.req.param('id') },
      paths,
    );
    return c.json(result, preparedDiffHttpStatus(result));
  });

  routes.get('/prepared-diffs/:id/recovery', async (c) => {
    const result = await readAutopilotRecoveryOptions(
      { preparedDiffId: c.req.param('id') },
      paths,
    );
    return c.json(result, preparedDiffHttpStatus(result));
  });

  routes.post('/prepared-diffs/:id/recovery/run', async (c) => {
    const result = await runAutopilotRecoveryAction(
      { ...(await safeJsonObject(c)), preparedDiffId: c.req.param('id') },
      paths,
    );
    recordHandledPrApiResult(paths, 'api:autopilot_recovery', result);
    return c.json(result, preparedDiffHttpStatus(result));
  });

  routes.post('/autopilot/verify-pr-worktree', async (c) => {
    const result = await verifyPrWorktree(await safeJsonBody(c), paths);
    recordHandledPrApiResult(paths, 'api:verify_pr_worktree', result);
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/autopilot/push-pr-autofix', async (c) => {
    const result = await pushPrAutofix(await safeJsonBody(c), paths);
    recordHandledPrApiResult(paths, 'api:push_pr_autofix', result);
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/prepared-diffs/:id/push', async (c) => {
    const result = await pushPrAutofix(
      { ...(await safeJsonObject(c)), preparedDiffId: c.req.param('id') },
      paths,
    );
    recordHandledPrApiResult(paths, 'api:push_pr_autofix', result);
    return c.json(result, result.ok ? 200 : 400);
  });

  return routes;
}

function approvalNotFound(message: string | undefined) {
  return Boolean(message?.includes('was not found'));
}
