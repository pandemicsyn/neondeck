import { Hono } from 'hono';
import * as v from 'valibot';
import {
  commentPrAutofixResult,
  fixPrCiFailure,
  fixPrReviewFeedback,
  abandonPreparedDiffWithRevisionAbort,
  autopilotReadinessInputSchema,
  preparePrWorktree,
  pushPrAutofix,
  readAutopilotReadiness,
  runPreparedDiffRevision,
  triagePrEvent,
  verifyPrWorktree,
} from '../../modules/autopilot';
import {
  readAutopilotRecoveryOptions,
  runAutopilotRecoveryAction,
} from '../../modules/autopilot/recovery';
import {
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
import { approvePreparedDiffPushWithDispatch } from '../autopilot-push-dispatch';
import {
  preparedDiffHttpStatus,
  queryBoolean,
  queryNumber,
  safeJsonBody,
  safeJsonObject,
} from '../http';
import { recordHandledPrApiResult } from '../learning-hooks';
import {
  readAutopilotAdmissionInspection,
  readAutopilotOwnerInspection,
} from '../../modules/autopilot/owner/inspection';

export function createAutopilotRoutes(paths: RuntimePaths) {
  const routes = new Hono();

  routes.get('/autopilot/owners/:id', async (c) => {
    const inspection = await readAutopilotOwnerInspection(
      c.req.param('id'),
      paths,
    );
    return inspection
      ? c.json({ ok: true, action: 'autopilot_owner_inspection', inspection })
      : c.json(
          {
            ok: false,
            action: 'autopilot_owner_inspection',
            message: 'Owner not found.',
          },
          404,
        );
  });

  routes.get('/autopilot/admissions/:id', async (c) => {
    const inspection = await readAutopilotAdmissionInspection(
      c.req.param('id'),
      paths,
    );
    return inspection
      ? c.json({
          ok: true,
          action: 'autopilot_admission_inspection',
          inspection,
        })
      : c.json(
          {
            ok: false,
            action: 'autopilot_admission_inspection',
            message: 'Admission not found.',
          },
          404,
        );
  });

  routes.get('/autopilot/readiness', async (c) => {
    const rawPrNumber = c.req.query('prNumber');
    const prNumber = queryNumber(rawPrNumber);
    const parsed = v.safeParse(autopilotReadinessInputSchema, {
      repoId: c.req.query('repoId'),
      prNumber:
        rawPrNumber === undefined ? undefined : (prNumber ?? rawPrNumber),
      mode: c.req.query('mode'),
    });
    if (!parsed.success) {
      return c.json(
        {
          ok: false,
          action: 'autopilot_readiness_read',
          changed: false,
          message: 'Invalid Autopilot readiness query.',
          errors: [v.summarize(parsed.issues)],
        },
        400,
      );
    }
    try {
      return c.json(await readAutopilotReadiness(parsed.output, paths));
    } catch (error) {
      return c.json(
        {
          ok: false,
          action: 'autopilot_readiness_read',
          changed: false,
          message: error instanceof Error ? error.message : String(error),
        },
        400,
      );
    }
  });

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
        ? await approvePreparedDiffPushWithDispatch(
            {
              preparedDiffId: approval.preparedDiffId,
              confirm: true,
              reason: 'Approved from dashboard Autopilot panel.',
              approverSurface: 'dashboard',
            },
            paths,
          )
        : await resolvePreparedDiffRevisionFromRoute(
            approval.preparedDiffId,
            input,
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
        expectedRevisionKey: c.req.query('expectedRevisionKey'),
        maxPatchBytes: queryNumber(c.req.query('maxPatchBytes')),
      },
      paths,
    );
    return c.json(result, preparedDiffHttpStatus(result));
  });

  routes.post('/prepared-diffs/:id/approve-push', async (c) => {
    const result = await approvePreparedDiffPushWithDispatch(
      { ...(await safeJsonObject(c)), preparedDiffId: c.req.param('id') },
      paths,
    );
    return c.json(result, preparedDiffHttpStatus(result));
  });

  routes.post('/prepared-diffs/:id/request-revision', async (c) => {
    const body = await safeJsonObject(c);
    const requested = await requestPreparedDiffRevision(
      { ...body, preparedDiffId: c.req.param('id') },
      paths,
    );
    const result =
      requested.ok && (body.runRevisionNow === true || body.runNow === true)
        ? await runPreparedDiffRevision(
            {
              preparedDiffId: c.req.param('id'),
              reason: typeof body.reason === 'string' ? body.reason : undefined,
              approverSurface:
                typeof body.approverSurface === 'string'
                  ? body.approverSurface
                  : 'dashboard',
            },
            paths,
          )
        : requested;
    return c.json(result, preparedDiffHttpStatus(result));
  });

  routes.post('/prepared-diffs/:id/run-revision', async (c) => {
    const result = await runPreparedDiffRevision(
      { ...(await safeJsonObject(c)), preparedDiffId: c.req.param('id') },
      paths,
    );
    return c.json(result, preparedDiffHttpStatus(result));
  });

  routes.post('/prepared-diffs/:id/abandon', async (c) => {
    const result = await abandonPreparedDiffWithRevisionAbort(
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
      { allowRevisionDispatch: true },
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

async function resolvePreparedDiffRevisionFromRoute(
  preparedDiffId: string,
  input: Record<string, unknown>,
  paths: RuntimePaths,
) {
  const reason = typeof input.reason === 'string' ? input.reason : undefined;
  const runRevisionNow = input.runRevisionNow !== false;
  if (runRevisionNow && !reason?.trim()) {
    return {
      ok: false,
      action: 'prepared_diff_request_revision',
      changed: false,
      message: 'Running a prepared-diff revision requires a revision note.',
      requires: ['reason'],
      errors: ['reason is required.'],
    };
  }
  const requested = await requestPreparedDiffRevision(
    {
      preparedDiffId,
      reason,
      approverSurface: 'dashboard',
    },
    paths,
  );
  if (!requested.ok || !runRevisionNow) return requested;
  const run = await runPreparedDiffRevision(
    {
      preparedDiffId,
      reason,
      approverSurface: 'dashboard',
    },
    paths,
  );
  return {
    ...run,
    data: { request: requested, run },
  };
}
