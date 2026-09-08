import { repoWorkflowProfileSchema } from '../../../shared/repo-workflows';
import { workflowCommandCwd } from '../repo-workflow-runtime';
import { deliveryCheckCommandsSchema } from '../../../shared/factory-delivery';
import { realpath, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import * as v from 'valibot';
import {
  candidateVerificationSchema,
  candidateCheckLogSchema,
} from './verification-contract';
import { checkExecutionPolicy } from '../execution';
import { resolveWorktreeVerificationChecks } from '../worktree-verification';
import {
  runtimePaths,
  type RuntimePaths,
  type RepoConfig,
} from '../../runtime-home';
import type { LocalAttemptHandle } from '../coding-runs';
import { hostGit } from '../coding-runs';
import {
  assertCandidateEvidenceCurrent,
  captureCandidateTree,
  type CandidateEvidence,
} from './evidence';
import { artifactHash } from '../coding-runs';
import { atomicWrite, readSigned, writeSigned } from '../coding-runs';
import { executionResult } from '../execution';
import {
  runCandidateCheck,
  candidateCheckResultSchema,
} from './verification-process';

export { cancelCandidateVerification } from './verification-supervisor';
import {
  runSupervisedCandidateCheck,
  recoverExistingCandidateCheck,
} from './verification-supervisor';

export const verificationLimitsSchema = v.strictObject({
  checks: deliveryCheckCommandsSchema,
  workflow: v.optional(repoWorkflowProfileSchema),
  timeoutMs: v.pipe(
    v.number(),
    v.safeInteger(),
    v.minValue(1),
    v.maxValue(600000),
  ),
  maxOutputBytes: v.pipe(
    v.number(),
    v.safeInteger(),
    v.minValue(1),
    v.maxValue(1024 * 1024),
  ),
  remainingMs: v.pipe(
    v.number(),
    v.safeInteger(),
    v.minValue(1),
    v.maxValue(3 * 60 * 60 * 1000),
  ),
});
export type CandidateVerification = v.InferOutput<
  typeof candidateVerificationSchema
>;
export function configuredCandidateChecks(
  repo: RepoConfig,
  policyChecks: string[],
) {
  return resolveWorktreeVerificationChecks(undefined, repo, policyChecks);
}
export class VerificationTreeDriftError extends Error {
  constructor(readonly actualTreeSha: string) {
    super('Verification checkout tree drift');
  }
}
export async function assertVerificationCheckout(
  root: string,
  evidence: CandidateEvidence,
  directory: string,
) {
  if ((await realpath(root)) !== root || root === evidence.root)
    throw new Error('Verification needs a separate canonical checkout');
  const common = async (path: string) =>
    realpath(
      resolve(
        path,
        (await hostGit(path, ['rev-parse', '--git-common-dir'])).trim(),
      ),
    );
  if (
    (await common(root)) !== (await common(evidence.root)) ||
    !(await hostGit(evidence.root, ['worktree', 'list', '--porcelain']))
      .split('\n')
      .includes(`worktree ${root}`)
  )
    throw new Error('Verification checkout ownership mismatch');
  if ((await hostGit(root, ['rev-parse', '--show-toplevel'])).trim() !== root)
    throw new Error('Verification must use a worktree root');
  // Also runs the no-filter/no-submodule read policy before any checks.
  await hostGit(root, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ]);
  const actualTreeSha = await captureCandidateTree(root, directory);
  if (actualTreeSha !== evidence.treeSha)
    throw new VerificationTreeDriftError(actualTreeSha);
}
// Product service admits exact checks and reserves cumulative budget/checkout
// ownership. This runner cannot grant authority or expand execution policy.
export async function verifyCandidateEvidence(
  input: v.InferOutput<typeof verificationLimitsSchema> & {
    handle: LocalAttemptHandle;
    evidence: CandidateEvidence;
    verificationRoot: string;
    jobId: string;
    recoverOnly?: boolean;
  },
  paths: RuntimePaths = runtimePaths(),
  dependencies: {
    runCheck?: typeof runCandidateCheck;
    checkPolicy?: typeof checkExecutionPolicy;
    assertAuthority?: () => void | Promise<void>;
  } = {},
): Promise<CandidateVerification> {
  const {
    handle,
    evidence,
    verificationRoot,
    jobId,
    recoverOnly,
    ...rawLimits
  } = input;
  const limits = v.parse(verificationLimitsSchema, rawLimits);
  const reportPath = join(
    handle.directory,
    `verification-report-${artifactHash(jobId)}.json`,
  );
  const requestHash = artifactHash(
    JSON.stringify({
      jobId,
      verificationRoot,
      evidenceDigest: evidence.evidenceDigest,
      limits,
    }),
  );
  const persist = async (raw: unknown) => {
    const report = v.parse(candidateVerificationSchema, raw);
    await writeSigned(reportPath, handle.attemptToken, { requestHash, report });
    return report;
  };
  if (recoverOnly && limits.workflow) {
    try {
      const retained = v.parse(
        v.strictObject({
          requestHash: v.string(),
          report: candidateVerificationSchema,
        }),
        await readSigned(reportPath, handle.attemptToken),
      );
      if (retained.requestHash !== requestHash)
        throw new Error('Verification report request mismatch');
      await assertCandidateEvidenceCurrent(handle, evidence);
      if (retained.report.passed)
        await assertVerificationCheckout(
          verificationRoot,
          evidence,
          handle.directory,
        );
      return retained.report;
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
    }
  }
  const checks: CandidateVerification['checks'] = [];
  const setupChecks: CandidateVerification['checks'] = [];
  const steps = limits.workflow
    ? [
        ...limits.workflow.setupCommands.map((c) => ({
          ...c,
          phase: 'setup' as const,
        })),
        ...limits.workflow.validationCommands.map((c) => ({
          ...c,
          phase: 'validation' as const,
        })),
      ]
    : limits.checks.map((command) => ({
        command,
        cwd: '.',
        phase: 'validation' as const,
      }));
  if (
    limits.workflow &&
    JSON.stringify(limits.workflow.validationCommands.map((c) => c.command)) !==
      JSON.stringify(limits.checks)
  )
    throw new Error('Approved workflow check contract mismatch');
  if (limits.workflow && !recoverOnly) {
    await dependencies.assertAuthority?.();
    await assertCandidateEvidenceCurrent(handle, evidence);
    await assertVerificationCheckout(
      verificationRoot,
      evidence,
      handle.directory,
    );
    for (const step of steps) {
      const decision = await (dependencies.checkPolicy ?? checkExecutionPolicy)(
        { command: step.command, backend: 'local', context: 'unattended' },
        paths,
      );
      if (decision.decision !== 'allow')
        return persist({
          evidenceDigest: evidence.evidenceDigest,
          revision: evidence.revision,
          passed: false,
          noWriter: true,
          durationMs: 0,
          checks: [],
          setup: {
            passed: false,
            checks: [],
            failure: {
              command: step.command,
              cwd: step.cwd,
              output:
                'Execution policy does not permit this command. Configure unattended local command permission, then explicitly retry the unchanged approved workflow.',
            },
          },
        });
    }
  }
  let runtimeBlocked = false;
  let stepIndex = 0;
  const started = Date.now();
  let phaseStarted = started;
  let previousPhase: string | undefined;
  for (const { command, cwd, phase } of steps) {
    const targetChecks = phase === 'setup' ? setupChecks : checks;
    if (phase !== previousPhase) {
      phaseStarted = Date.now();
      previousPhase = phase;
    }
    await dependencies.assertAuthority?.();
    await assertCandidateEvidenceCurrent(handle, evidence);
    try {
      await assertVerificationCheckout(
        verificationRoot,
        evidence,
        handle.directory,
      );
    } catch (error) {
      // Recovery is read-only: a settled check may have left the retained
      // workspace dirty before the controller could persist its failed report.
      if (!(recoverOnly && error instanceof VerificationTreeDriftError))
        throw error;
    }
    const policy = await (dependencies.checkPolicy ?? checkExecutionPolicy)(
      { command, backend: 'local', context: 'unattended' },
      paths,
    );
    if (policy.decision !== 'allow') {
      targetChecks.push({
        command,
        ...(limits.workflow ? { cwd } : {}),
        passed: false,
        exitCode: null,
        truncated: false,
        durationMs: 0,
        evidenceRef: null,
        outputHash: null,
      });
      break;
    }
    const recordedRemaining =
      limits.remainingMs -
      [...setupChecks, ...checks].reduce(
        (sum, check) => sum + check.durationMs,
        0,
      );
    const remaining = recoverOnly
      ? recordedRemaining
      : Math.min(
          recordedRemaining,
          limits.remainingMs - (Date.now() - started),
        );
    const phaseBudget = limits.workflow
      ? phase === 'setup'
        ? limits.workflow.setupTimeoutMs
        : limits.workflow.validationTimeoutMs
      : limits.timeoutMs;
    const phaseRemaining = !limits.workflow
      ? limits.timeoutMs
      : Math.min(
          phaseBudget - targetChecks.reduce((n, c) => n + c.durationMs, 0),
          recoverOnly ? phaseBudget : phaseBudget - (Date.now() - phaseStarted),
        );
    const timeoutMs = Math.max(1, Math.min(phaseRemaining, remaining));
    let resolvedCwd: string | null = null;
    try {
      resolvedCwd = await workflowCommandCwd(verificationRoot, cwd);
    } catch {
      /* Known no-process setup failure, retained below. */
    }
    const checkInput = {
      command: policy.command,
      cwd: resolvedCwd ?? verificationRoot,
      ...(limits.workflow
        ? {
            workflow: {
              root: verificationRoot,
              runtime: limits.workflow.runtime,
              environmentRefs: limits.workflow.environmentRefs,
            },
          }
        : {}),
      timeoutMs,
      maxOutputBytes: limits.maxOutputBytes,
    };
    const result = v.parse(
      candidateCheckResultSchema,
      !resolvedCwd || remaining <= 0 || phaseRemaining <= 0
        ? {
            setupBlocked: !resolvedCwd || phase === 'setup',
            noWriter: true,
            exitCode: null,
            truncated: false,
            timedOut: remaining <= 0 || phaseRemaining <= 0,
            cancelled: false,
            durationMs: 0,
            stdout: '',
            stderr: !resolvedCwd
              ? 'ENVIRONMENT SETUP: command directory is missing or outside the owned checkout.'
              : 'Approved workflow phase or cumulative execution budget exhausted.',
          }
        : await (dependencies.runCheck
            ? dependencies.runCheck(checkInput)
            : (recoverOnly
                ? recoverExistingCandidateCheck
                : runSupervisedCandidateCheck)(
                checkInput,
                handle,
                `${jobId}:${stepIndex++}`,
                jobId,
              )),
    );
    runtimeBlocked ||= result.setupBlocked === true;
    if (!result.noWriter)
      throw new Error(
        'Verification process death is unproven; retain checkout ownership',
      );
    await assertCandidateEvidenceCurrent(handle, evidence);
    let mutation: {
      reason: string;
      expectedTreeSha: string;
      actualTreeSha: string;
    } | null = null;
    try {
      await assertVerificationCheckout(
        verificationRoot,
        evidence,
        handle.directory,
      );
    } catch (error) {
      if (!(error instanceof VerificationTreeDriftError)) throw error;
      mutation = {
        reason: 'Check changed certified checkout contents',
        expectedTreeSha: evidence.treeSha,
        actualTreeSha: error.actualTreeSha,
      };
    }
    const sanitized = executionResult({
      ...result,
      outputLimit: limits.maxOutputBytes,
    });
    const logDirectory = await mkdtemp(join(handle.directory, 'verification-'));
    const evidenceRef = join(logDirectory, 'output.json');
    const output = JSON.stringify(
      v.parse(candidateCheckLogSchema, {
        command,
        ...(limits.workflow ? { cwd } : {}),
        evidenceDigest: evidence.evidenceDigest,
        treeSha: evidence.treeSha,
        ...sanitized,
        mutation,
        environment: result.environment,
      }),
    );
    await atomicWrite(evidenceRef, output);
    const outputHash = artifactHash(output);
    const passed =
      (dependencies.runCheck !== undefined ||
        result.environment?.policy === 'private-check-env-v1') &&
      mutation === null &&
      result.exitCode === 0 &&
      !result.truncated &&
      !result.timedOut &&
      !result.cancelled &&
      result.durationMs <= timeoutMs &&
      result.durationMs <= remaining &&
      (recoverOnly ||
        !limits.workflow ||
        Date.now() - phaseStarted <= phaseBudget);
    targetChecks.push({
      command,
      ...(limits.workflow ? { cwd } : {}),
      passed,
      exitCode: result.exitCode,
      truncated: result.truncated,
      durationMs: result.durationMs,
      evidenceRef,
      outputHash,
      ...(result.environment ? { environment: result.environment } : {}),
    });
    if (!passed) break;
  }
  await assertCandidateEvidenceCurrent(handle, evidence);
  return persist({
    evidenceDigest: evidence.evidenceDigest,
    revision: evidence.revision,
    passed:
      !runtimeBlocked &&
      (!limits.workflow ||
        setupChecks.length === limits.workflow.setupCommands.length) &&
      checks.length === limits.checks.length &&
      checks.every((c) => c.passed) &&
      setupChecks.every((c) => c.passed),
    ...(limits.workflow
      ? {
          setup: {
            passed:
              !runtimeBlocked &&
              setupChecks.length === limits.workflow.setupCommands.length &&
              setupChecks.every((c) => c.passed),
            checks: setupChecks,
          },
        }
      : {}),
    durationMs: [...setupChecks, ...checks].reduce(
      (sum, check) => sum + check.durationMs,
      0,
    ),
    noWriter: true,
    checks,
  });
}
