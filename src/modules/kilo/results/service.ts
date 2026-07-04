import { asJsonValue } from '../../../lib/action-result';
import { checkAutopilotPolicy } from '../../../autopilot-policy';
import { verifyPrWorktree } from '../../../autopilot-workflows';
import { notifyKiloState, resolveKiloNotifications } from '../notifications';
import { getGitHubPrBranchPermissions } from '../../../pr-event-state';
import { ensurePreparedDiffForWorktree } from '../../../prepared-diffs';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from '../../../runtime-home';
import {
  assertReviewableTask,
  assertVerificationGate,
  classifyReview,
  diffFingerprintForTask,
  findTaskWorktree,
  readTaskDiff,
  reviewReasons,
  taskStatusForClassification,
} from './gates';
import {
  jsonBoolean,
  listStateRows,
  notFound,
  parseInput,
  pendingApprovalsFor,
  readKiloResultState,
  readKiloTask,
  readPreparedDiffByWorktree,
  readStateRow,
  resetPreparedDiffApproval,
  insertKiloResultEvent,
  updateKiloTaskStatus,
  upsertKiloResultState,
} from './state';
import {
  promoteInputSchema,
  stateListInputSchema,
  taskIdInputSchema,
  verifyInputSchema,
  type KiloResultActionResult,
  type KiloResultClassification,
  type KiloResultState,
  type KiloVerificationStatus,
} from './schemas';

export async function reviewKiloResult(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
): Promise<KiloResultActionResult> {
  const parsed = parseInput(taskIdInputSchema, rawInput, 'kilo_result_review');
  if (!parsed.ok) return parsed.result;
  await ensureRuntimeHome(paths);
  const task = readKiloTask(parsed.input.taskId, paths);
  if (!task) return notFound('kilo_result_review', parsed.input.taskId);
  const reviewAdmission = assertReviewableTask(task, 'kilo_result_review');
  if (!reviewAdmission.ok) return reviewAdmission.result;

  const diff = await readTaskDiff(task);
  const worktree = await findTaskWorktree(task, paths);
  const hasReviewableDiff = diff.ok && diff.fileCount > 0;
  const previous = readKiloResultState(task.id, paths);
  const fingerprint = await diffFingerprintForTask(task, diff);
  const diffChanged = Boolean(
    previous?.diffFingerprint && previous.diffFingerprint !== fingerprint,
  );
  const preparedDiff =
    worktree && hasReviewableDiff
      ? await ensurePreparedDiffForWorktree(worktree, paths, {
          title: `Kilo: ${task.title}`,
          createdBy: 'kilo',
          summary: {
            kiloTaskId: task.id,
            source: 'review_kilo_result',
          },
        })
      : null;
  const adoptedExistingPreparedDiff = Boolean(preparedDiff && !previous);
  if (preparedDiff && (diffChanged || adoptedExistingPreparedDiff)) {
    resetPreparedDiffApproval(
      preparedDiff.id,
      diffChanged
        ? 'Kilo result diff changed after earlier review.'
        : 'Kilo adopted this prepared diff; previous push decision is no longer current.',
      paths,
    );
  }
  const preparedDiffForState =
    preparedDiff && (diffChanged || adoptedExistingPreparedDiff)
      ? { ...preparedDiff, pushApprovalStatus: 'pending' }
      : preparedDiff;
  const policy = worktree
    ? await checkAutopilotPolicy({ worktreeId: worktree.id }, paths)
    : null;
  const classification = classifyReview(task, diff, worktree, policy);
  const summary = {
    classification,
    reasons: reviewReasons(task, diff, worktree, policy),
    changedFiles: diff.files.map((file) => file.path),
  };
  const state = upsertKiloResultState(
    task.id,
    {
      preparedDiffId: preparedDiffForState?.id ?? null,
      classification,
      verificationStatus: 'not-run',
      promotionStatus: 'not-requested',
      diffFingerprint: fingerprint,
      verifiedDiffFingerprint: null,
      reviewSummary: summary,
      diffSummary: diff,
      policy,
      verification: null,
      promotion: null,
      pendingApprovals: pendingApprovalsFor(preparedDiffForState, policy),
      reviewedAt: new Date().toISOString(),
      verifiedAt: null,
      promotedAt: null,
    },
    paths,
  );
  updateKiloTaskStatus(
    task.id,
    taskStatusForClassification(classification),
    paths,
  );
  insertKiloResultEvent(
    task.id,
    'review',
    `Kilo result classified as ${classification}.`,
    {
      classification,
      preparedDiffId: preparedDiffForState?.id ?? null,
      diffFingerprint: fingerprint,
      diffChanged,
      summary,
    },
    paths,
  );
  if (classification === 'discard') {
    await resolveKiloNotifications(
      task.id,
      ['started', 'progress', 'completed', 'waiting-approval', 'needs-review'],
      paths,
    );
  } else {
    await notifyKiloState(
      {
        taskId: task.id,
        state:
          classification === 'needs-review'
            ? 'needs-review'
            : state.pendingApprovals.length > 0
              ? 'waiting-approval'
              : 'completed',
        title:
          classification === 'ready-to-verify'
            ? 'Kilo result ready to verify'
            : classification === 'ready-to-push'
              ? 'Kilo result ready for promotion'
              : undefined,
        message: `Kilo result classified as ${classification}.`,
        repoId: task.repoId,
        repoFullName: task.repoFullName,
        worktreeId: task.worktreeId,
        preparedDiffId: state.preparedDiffId,
        workflow: 'review_kilo_result',
        pendingApprovals: state.pendingApprovals,
        data: { classification, summary },
      },
      paths,
    );
  }

  return {
    ok: true,
    action: 'kilo_result_review',
    changed: true,
    message: `Kilo result classified as ${classification}.`,
    task: readKiloTask(task.id, paths) ?? task,
    resultState: state,
    diff,
    data: asJsonValue({
      nextWorkflow:
        classification === 'ready-to-verify'
          ? 'verify_kilo_result'
          : classification === 'ready-to-push'
            ? 'promote_kilo_result'
            : null,
      preparedDiff: preparedDiffForState,
      policy,
    }),
  };
}

export async function verifyKiloResult(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
): Promise<KiloResultActionResult> {
  const parsed = parseInput(verifyInputSchema, rawInput, 'kilo_result_verify');
  if (!parsed.ok) return parsed.result;
  await ensureRuntimeHome(paths);
  const task = readKiloTask(parsed.input.taskId, paths);
  if (!task) return notFound('kilo_result_verify', parsed.input.taskId);
  const reviewAdmission = assertReviewableTask(task, 'kilo_result_verify');
  if (!reviewAdmission.ok) return reviewAdmission.result;
  const stateBefore = readKiloResultState(task.id, paths);
  const reviewGate = await assertVerificationGate(task, stateBefore, paths);
  if (!reviewGate.ok) {
    const state = upsertKiloResultState(
      task.id,
      {
        verificationStatus: 'blocked',
        verification: { reason: reviewGate.message },
      },
      paths,
    );
    await notifyKiloState(
      {
        taskId: task.id,
        state: reviewGate.requires.includes('approval')
          ? 'waiting-approval'
          : 'failed',
        title: 'Kilo verification blocked',
        message: reviewGate.message,
        repoId: task.repoId,
        repoFullName: task.repoFullName,
        worktreeId: task.worktreeId,
        workflow: 'verify_kilo_result',
        data: { requires: reviewGate.requires },
      },
      paths,
    );
    return {
      ok: false,
      action: 'kilo_result_verify',
      changed: true,
      message: reviewGate.message,
      task,
      resultState: state,
      requires: reviewGate.requires,
    };
  }
  if (!task.worktreeId) {
    const state = upsertKiloResultState(
      task.id,
      {
        verificationStatus: 'blocked',
        verification: {
          reason: 'Kilo verification requires a managed worktree.',
        },
      },
      paths,
    );
    await notifyKiloState(
      {
        taskId: task.id,
        state: 'failed',
        title: 'Kilo verification blocked',
        message: 'Kilo verification requires a managed worktree.',
        repoId: task.repoId,
        repoFullName: task.repoFullName,
        worktreeId: task.worktreeId,
        workflow: 'verify_kilo_result',
        data: { requires: ['worktreeId'] },
      },
      paths,
    );
    return {
      ok: false,
      action: 'kilo_result_verify',
      changed: true,
      message: 'Kilo verification requires a managed worktree.',
      task,
      resultState: state,
      requires: ['worktreeId'],
    };
  }

  upsertKiloResultState(
    task.id,
    {
      verificationStatus: 'running',
      verification: { startedAt: new Date().toISOString() },
    },
    paths,
  );
  insertKiloResultEvent(
    task.id,
    'verification.started',
    'Started Kilo result verification through the autopilot verifier.',
    { worktreeId: task.worktreeId, checks: parsed.input.checks ?? null },
    paths,
  );

  const result = await verifyPrWorktree(
    {
      worktreeId: task.worktreeId,
      checks: parsed.input.checks,
      backend: parsed.input.backend,
      context: parsed.input.context,
      lock: parsed.input.lock,
      timeoutMs: parsed.input.timeoutMs,
      maxOutputBytes: parsed.input.maxOutputBytes,
    },
    paths,
  );
  const blocked = Array.isArray(result.requires) && result.requires.length > 0;
  const verificationStatus: KiloVerificationStatus = result.ok
    ? 'passed'
    : blocked
      ? 'blocked'
      : 'failed';
  const policy = task.worktreeId
    ? await checkAutopilotPolicy(
        { worktreeId: task.worktreeId, pushDestination: 'pull-request-head' },
        paths,
      )
    : null;
  const nextClassification: KiloResultClassification =
    result.ok && policy?.mode === 'autofix-push-when-safe'
      ? 'ready-to-push'
      : 'needs-review';
  const state = upsertKiloResultState(
    task.id,
    {
      classification: nextClassification,
      verificationStatus,
      verification: result,
      verifiedDiffFingerprint: result.ok ? reviewGate.fingerprint : null,
      verifiedAt: new Date().toISOString(),
    },
    paths,
  );
  updateKiloTaskStatus(task.id, nextClassification, paths);
  insertKiloResultEvent(
    task.id,
    `verification.${verificationStatus}`,
    result.message,
    result,
    paths,
  );
  await notifyKiloState(
    {
      taskId: task.id,
      state:
        verificationStatus === 'passed'
          ? 'verified'
          : verificationStatus === 'blocked' &&
              Array.isArray(result.requires) &&
              result.requires.includes('approval')
            ? 'waiting-approval'
            : 'failed',
      title:
        verificationStatus === 'passed'
          ? undefined
          : 'Kilo verification needs attention',
      message: result.ok ? 'Kilo result verification passed.' : result.message,
      repoId: task.repoId,
      repoFullName: task.repoFullName,
      worktreeId: task.worktreeId,
      workflow: 'verify_kilo_result',
      pendingApprovals: Array.isArray(result.requires)
        ? result.requires.map((item) => ({ type: item }))
        : [],
      data: { verificationStatus, result },
    },
    paths,
  );

  return {
    ok: result.ok,
    action: 'kilo_result_verify',
    changed: true,
    message: result.ok ? 'Kilo result verification passed.' : result.message,
    task: readKiloTask(task.id, paths) ?? task,
    resultState: state,
    data: asJsonValue({ verification: result }),
    ...(result.requires ? { requires: result.requires } : {}),
    ...(result.errors ? { errors: result.errors } : {}),
  };
}

export async function promoteKiloResult(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
): Promise<KiloResultActionResult> {
  const parsed = parseInput(
    promoteInputSchema,
    rawInput,
    'kilo_result_promote',
  );
  if (!parsed.ok) return parsed.result;
  await ensureRuntimeHome(paths);
  const task = readKiloTask(parsed.input.taskId, paths);
  if (!task) return notFound('kilo_result_promote', parsed.input.taskId);
  const reviewAdmission = assertReviewableTask(task, 'kilo_result_promote');
  if (!reviewAdmission.ok) return reviewAdmission.result;
  const worktree = await findTaskWorktree(task, paths);
  const state = readKiloResultState(task.id, paths);
  const policy = worktree
    ? await checkAutopilotPolicy(
        { worktreeId: worktree.id, pushDestination: 'pull-request-head' },
        paths,
      )
    : null;
  const currentDiff = await readTaskDiff(task);
  const currentFingerprint = await diffFingerprintForTask(task, currentDiff);
  const noCheckReadyToPush = Boolean(
    state?.classification === 'ready-to-push' &&
    state?.verificationStatus === 'not-run' &&
    policy?.ok &&
    policy.limits.requiredChecks.length === 0 &&
    state.diffFingerprint === currentFingerprint,
  );
  const gates: Array<{ gate: string; ok: boolean; reason: string }> = [];

  gates.push({
    gate: 'managed-worktree',
    ok: Boolean(worktree),
    reason: worktree
      ? 'Kilo task is linked to a managed worktree.'
      : 'Kilo task is not linked to a managed worktree.',
  });
  gates.push({
    gate: 'verification',
    ok: state?.verificationStatus === 'passed' || noCheckReadyToPush,
    reason:
      state?.verificationStatus === 'passed'
        ? 'Kilo verification has passed.'
        : noCheckReadyToPush
          ? 'No required checks are configured and the reviewed Kilo result is ready to push.'
          : 'Kilo verification has not passed.',
  });
  gates.push({
    gate: 'verified-diff',
    ok:
      state?.diffFingerprint === currentFingerprint &&
      (state?.verifiedDiffFingerprint === currentFingerprint ||
        noCheckReadyToPush),
    reason:
      state?.diffFingerprint === currentFingerprint &&
      (state?.verifiedDiffFingerprint === currentFingerprint ||
        noCheckReadyToPush)
        ? 'Current diff matches the reviewed and verified Kilo result.'
        : 'Current diff does not match the reviewed and verified Kilo result.',
  });

  gates.push({
    gate: 'autopilot-policy',
    ok: Boolean(policy?.ok && !policy.blocked && !policy.approvalRequired),
    reason:
      policy?.ok && !policy.blocked && !policy.approvalRequired
        ? 'Autopilot policy allows the diff.'
        : (policy?.message ?? 'Autopilot policy could not be evaluated.'),
  });
  gates.push({
    gate: 'autopilot-mode',
    ok: policy?.mode === 'autofix-push-when-safe',
    reason:
      policy?.mode === 'autofix-push-when-safe'
        ? 'Repo policy allows push when safe.'
        : `Repo policy mode is ${policy?.mode ?? 'unknown'}, not autofix-push-when-safe.`,
  });

  const preparedDiff = worktree
    ? readPreparedDiffByWorktree(worktree.id, paths)
    : null;
  gates.push({
    gate: 'prepared-diff-approval',
    ok: preparedDiff?.pushApprovalStatus === 'approved',
    reason:
      preparedDiff?.pushApprovalStatus === 'approved'
        ? 'Prepared diff push approval is approved.'
        : `Prepared diff push approval is ${preparedDiff?.pushApprovalStatus ?? 'missing'}.`,
  });

  const permissions =
    worktree?.prNumber && process.env.GITHUB_TOKEN
      ? await getGitHubPrBranchPermissions(
          { repo: worktree.repoFullName, prNumber: worktree.prNumber },
          paths,
        )
      : null;
  const canLikelyPush = Boolean(
    jsonBoolean(permissions?.data, ['branchPermissions', 'canLikelyPush']) ??
    worktree?.directPushAllowed,
  );
  gates.push({
    gate: 'github-permissions',
    ok: canLikelyPush,
    reason: canLikelyPush
      ? 'GitHub permission facts allow likely push-back.'
      : permissions
        ? permissions.message
        : 'GitHub permission facts are unavailable and worktree directPushAllowed is false.',
  });

  const admitted = gates.every((gate) => gate.ok);
  const promotion = {
    admitted,
    deferred: admitted,
    actualMutations: [],
    gates,
    policy,
    preparedDiff,
    permissions: permissions ?? null,
    deferral:
      'Actual commit, push, and PR comment mutations are deferred to the later push-back workflow.',
  };
  const next = upsertKiloResultState(
    task.id,
    {
      promotionStatus: admitted ? 'deferred' : 'blocked',
      promotion,
      policy,
      pendingApprovals: pendingApprovalsFor(preparedDiff, policy),
      promotedAt: new Date().toISOString(),
    },
    paths,
  );
  insertKiloResultEvent(
    task.id,
    admitted ? 'promotion.deferred' : 'promotion.blocked',
    admitted
      ? 'Kilo result passed promotion admission; actual push/comment is deferred.'
      : 'Kilo result is blocked from promotion.',
    promotion,
    paths,
  );
  await notifyKiloState(
    {
      taskId: task.id,
      state: admitted ? 'promoted' : 'promote-blocked',
      title: admitted ? 'Kilo promotion admitted' : undefined,
      message: admitted
        ? 'Kilo result passed promotion admission; push/comment remains delegated to push_pr_autofix.'
        : 'Kilo result is blocked from promotion.',
      repoId: task.repoId,
      repoFullName: task.repoFullName,
      worktreeId: task.worktreeId,
      preparedDiffId: next.preparedDiffId,
      workflow: 'promote_kilo_result',
      pendingApprovals: next.pendingApprovals,
      data: promotion,
    },
    paths,
  );

  return {
    ok: admitted,
    action: 'kilo_result_promote',
    changed: true,
    message: admitted
      ? 'Kilo result passed promotion admission. Commit, push, and comment are deferred.'
      : 'Kilo result did not pass promotion admission.',
    task,
    resultState: next,
    data: asJsonValue(promotion),
    requires: admitted
      ? ['push_pr_autofix']
      : gates.filter((gate) => !gate.ok).map((gate) => gate.gate),
  };
}

export async function listKiloResultStates(
  rawInput: unknown = {},
  paths: RuntimePaths = runtimePaths(),
): Promise<KiloResultActionResult & { resultStates?: KiloResultState[] }> {
  const parsed = parseInput(
    stateListInputSchema,
    rawInput,
    'kilo_result_state',
  );
  if (!parsed.ok) return parsed.result;
  await ensureRuntimeHome(paths);
  const rows = listStateRows(parsed.input, paths);
  const resultStates = rows.map(readStateRow);
  return {
    ok: true,
    action: 'kilo_result_state',
    changed: false,
    message: `Read ${resultStates.length} Kilo result state record(s).`,
    resultStates,
  };
}

export function readKiloResultStateSummary(
  taskId: string,
  paths: RuntimePaths = runtimePaths(),
) {
  const state = readKiloResultState(taskId, paths);
  if (!state) {
    return {
      verificationState: 'not-run',
      reviewClassification: null,
      promotionState: 'not-requested',
      preparedDiffId: null,
      pendingApprovals: [],
    };
  }
  return {
    verificationState: state.verificationStatus,
    reviewClassification: state.classification,
    promotionState: state.promotionStatus,
    preparedDiffId: state.preparedDiffId,
    pendingApprovals: state.pendingApprovals,
  };
}
