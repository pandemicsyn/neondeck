import { asJsonValue } from '../../../lib/action-result';
import { checkAutopilotPolicy } from '../../autopilot-policy';
import { notifyKiloState, resolveKiloNotifications } from '../notifications';
import { getGitHubPrBranchPermissions } from '../../pr-events';
import { ensurePreparedDiffForWorktree } from '../../prepared-diffs';
import { validateDocsDriftFixTaskDiff } from '../docs-drift-boundary';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from '../../../runtime-home';
import {
  assertReviewableTask,
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
  type KiloResultActionResult,
  type KiloResultState,
} from './schemas';

export { verifyKiloResult } from './verify';

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
  const docsDriftScopeViolation = validateDocsDriftFixTaskDiff(
    { id: task.id, title: task.title },
    diff,
    paths,
  );
  if (docsDriftScopeViolation) {
    const classification = 'needs-review' as const;
    const summary = {
      classification,
      reasons: [
        docsDriftScopeViolation.missingBoundary
          ? 'Docs drift fix boundary metadata is missing.'
          : 'Docs drift fix changed files outside the report allowlist.',
        ...docsDriftScopeViolation.disallowedPaths.map(
          (path) => `Out-of-scope path: ${path}`,
        ),
      ],
      changedFiles: docsDriftScopeViolation.changedPaths,
      docsDriftFix: {
        reportId: docsDriftScopeViolation.boundary?.reportId ?? null,
        allowedDocsPaths:
          docsDriftScopeViolation.boundary?.allowedDocsPaths ?? [],
        disallowedPaths: docsDriftScopeViolation.disallowedPaths,
        missingBoundary: docsDriftScopeViolation.missingBoundary,
      },
    };
    const state = upsertKiloResultState(
      task.id,
      {
        preparedDiffId: null,
        classification,
        verificationStatus: 'blocked',
        promotionStatus: 'blocked',
        diffFingerprint: fingerprint,
        verifiedDiffFingerprint: null,
        reviewSummary: summary,
        diffSummary: diff,
        policy: null,
        verification: null,
        promotion: {
          blocked: true,
          reason:
            'Docs drift fixes may only change documentation files listed in the originating report.',
        },
        pendingApprovals: [],
        reviewedAt: new Date().toISOString(),
        verifiedAt: null,
        promotedAt: null,
      },
      paths,
    );
    updateKiloTaskStatus(task.id, 'needs-review', paths);
    insertKiloResultEvent(
      task.id,
      'review',
      'Kilo result rejected because docs drift fix changed out-of-scope files.',
      {
        classification,
        diffFingerprint: fingerprint,
        summary,
      },
      paths,
    );
    await notifyKiloState(
      {
        taskId: task.id,
        state: 'needs-review',
        title: 'Docs drift fix changed out-of-scope files',
        message:
          'Docs drift fix changed files outside the report allowlist; no prepared diff was created.',
        repoId: task.repoId,
        repoFullName: task.repoFullName,
        worktreeId: task.worktreeId,
        workflow: 'review_kilo_result',
        data: { classification, summary },
      },
      paths,
    );

    return {
      ok: false,
      action: 'kilo_result_review',
      changed: true,
      message:
        'Docs drift fix changed files outside the report allowlist; no prepared diff was created.',
      task: readKiloTask(task.id, paths) ?? task,
      resultState: state,
      diff,
      requires: ['docs-only-diff'],
      data: asJsonValue({ docsDriftFix: docsDriftScopeViolation }),
    };
  }
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
      'Actual commit, push, and PR comment mutations require explicit human follow-up.',
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
        ? 'Kilo result passed promotion admission; commit, push, and comment remain explicit human follow-up.'
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
      ? ['explicit-human-delivery']
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
