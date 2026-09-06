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
import { atomicWrite } from '../coding-runs';
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
  const checks: CandidateVerification['checks'] = [];
  for (const command of limits.checks) {
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
      checks.push({
        command,
        passed: false,
        exitCode: null,
        truncated: false,
        durationMs: 0,
        evidenceRef: null,
        outputHash: null,
      });
      break;
    }
    const remaining =
      limits.remainingMs -
      checks.reduce((sum, check) => sum + check.durationMs, 0);
    if (remaining <= 0) break;
    const checkInput = {
      command: policy.command,
      cwd: verificationRoot,
      timeoutMs: Math.min(limits.timeoutMs, remaining),
      maxOutputBytes: limits.maxOutputBytes,
    };
    const result = v.parse(
      candidateCheckResultSchema,
      await (dependencies.runCheck
        ? dependencies.runCheck(checkInput)
        : (recoverOnly
            ? recoverExistingCandidateCheck
            : runSupervisedCandidateCheck)(
            checkInput,
            handle,
            `${jobId}:${checks.length}`,
            jobId,
          )),
    );
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
      result.durationMs <= remaining;
    checks.push({
      command,
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
  return v.parse(candidateVerificationSchema, {
    evidenceDigest: evidence.evidenceDigest,
    revision: evidence.revision,
    passed:
      checks.length === limits.checks.length && checks.every((c) => c.passed),
    durationMs: checks.reduce((sum, check) => sum + check.durationMs, 0),
    noWriter: true,
    checks,
  });
}
