import { asJsonValue } from '../../../lib/action-result';
import {
  checkAutopilotConcurrency,
  checkAutopilotPolicy,
  withAutopilotLocalExecutionSlot,
} from '../../autopilot-policy';
import { notifyKiloState } from '../notifications';
import { readRepoRegistrySnapshot } from '../../repos';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from '../../../runtime-home';
import {
  resolveWorktreeVerificationChecks,
  verifyWorktreeChecks,
} from '../../worktree-verification';
import { assertReviewableTask, assertVerificationGate } from './gates';
import {
  insertKiloResultEvent,
  notFound,
  parseInput,
  readKiloResultState,
  readKiloTask,
  updateKiloTaskStatus,
  upsertKiloResultState,
} from './state';
import {
  verifyInputSchema,
  type KiloResultActionResult,
  type KiloResultClassification,
  type KiloVerificationStatus,
} from './schemas';

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
    'Started Kilo result verification through the worktree verifier.',
    { worktreeId: task.worktreeId, checks: parsed.input.checks ?? null },
    paths,
  );

  const policy = await checkAutopilotPolicy(
    { worktreeId: task.worktreeId, pushDestination: 'pull-request-head' },
    paths,
  );
  const registry = await readRepoRegistrySnapshot(paths);
  const repo = registry.repos.find((candidate) => candidate.id === task.repoId);
  const concurrency = repo
    ? await checkAutopilotConcurrency(
        {
          repoId: repo.id,
          prNumber: policy.prNumber,
          workflow: 'verify_kilo_result',
          mutation: true,
        },
        paths,
      )
    : null;
  const checks = repo
    ? resolveWorktreeVerificationChecks(
        parsed.input.checks,
        repo,
        policy.ok && !policy.blocked ? policy.limits.requiredChecks : [],
      )
    : [];
  const result = await (async () => {
    if (!repo) {
      return {
        ok: false,
        action: 'kilo_result_verify',
        changed: false,
        message: `Repository "${task.repoId}" is not configured.`,
        requires: ['repo'],
      };
    }
    if (!concurrency?.allowed) {
      return {
        ok: false,
        action: 'kilo_result_verify',
        changed: false,
        message:
          concurrency?.message ?? 'Autopilot concurrency blocks admission.',
        data: asJsonValue({ concurrency }),
        errors: concurrency?.reasons ?? [],
        requires: ['concurrency'],
      };
    }
    if (!policy.ok || policy.blocked) {
      return {
        ok: false,
        action: 'kilo_result_verify',
        changed: false,
        message: policy.message,
        data: asJsonValue({ policy }),
        errors: policy.reasons,
        requires: policy.requires,
      };
    }
    if (checks.length === 0) {
      return {
        ok: false,
        action: 'kilo_result_verify',
        changed: false,
        message: 'No repo checks are configured for this worktree.',
        requires: ['guardrails.requiredChecks', 'repo.packageScripts'],
      };
    }
    const worktreeId = task.worktreeId;
    if (!worktreeId) {
      return {
        ok: false,
        action: 'kilo_result_verify',
        changed: false,
        message: 'Kilo verification requires a managed worktree.',
        requires: ['worktreeId'],
      };
    }
    try {
      const verification = await verifyWorktreeChecks(
        {
          worktreeId,
          checks,
          backend: parsed.input.backend,
          context: parsed.input.context,
          lock: parsed.input.lock,
          timeoutMs: parsed.input.timeoutMs,
          maxOutputBytes: parsed.input.maxOutputBytes,
          requestContext: {
            source: 'kilo',
            workflow: 'verify_kilo_result',
          },
        },
        paths,
        {
          runCheck: ({ defaultRun }) =>
            withAutopilotLocalExecutionSlot(policy.concurrency, defaultRun),
        },
      );
      return {
        ok: verification.ok,
        action: 'kilo_result_verify',
        changed: true,
        message: verification.ok
          ? `Verified ${verification.repoFullName}#${verification.worktree.prNumber ?? 'worktree'} with ${verification.results.length} check(s).`
          : verification.blocked
            ? 'Verification is blocked by execution approval or concurrency policy.'
            : 'One or more verification checks failed.',
        data: asJsonValue({ policy, verification }),
        errors: verification.results
          .filter((item) => !item.ok)
          .map((item) => item.message),
        requires: verification.blocked ? ['approval'] : undefined,
      };
    } catch (error) {
      return {
        ok: false,
        action: 'kilo_result_verify',
        changed: false,
        message:
          error instanceof Error
            ? error.message
            : 'Could not verify Kilo result worktree.',
        errors: [error instanceof Error ? error.message : String(error)],
      };
    }
  })();
  const blocked = Array.isArray(result.requires) && result.requires.length > 0;
  const verificationStatus: KiloVerificationStatus = result.ok
    ? 'passed'
    : blocked
      ? 'blocked'
      : 'failed';
  const nextClassification: KiloResultClassification =
    result.ok && policy?.mode === 'autofix-push-when-safe'
      ? 'ready-to-push'
      : 'needs-review';
  const state = upsertKiloResultState(
    task.id,
    {
      classification: nextClassification,
      verificationStatus,
      verification: asJsonValue(result),
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
    asJsonValue(result),
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
