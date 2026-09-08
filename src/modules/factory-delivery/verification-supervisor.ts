import {
  discoverWorkflowToolchain,
  workflowEnvironmentValues,
} from '../repo-workflow-runtime';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';
import {
  artifactHash,
  atomicWrite,
  privateDirectory,
  readSigned,
  writeSigned,
  type LocalAttemptHandle,
} from '../coding-runs/worker';
import {
  candidateCheckInputSchema,
  candidateCheckResultSchema,
  prepareCandidateCheckEnvironment,
} from './verification-process';
export const checkJobSchema = v.strictObject({
  jobId: v.string(),
  cancellationId: v.string(),
  request: candidateCheckInputSchema,
});
export const checkTerminalSchema = v.strictObject({
  jobId: v.string(),
  requestHash: v.string(),
  result: candidateCheckResultSchema,
});
export function verificationCancellationPath(
  handle: LocalAttemptHandle,
  jobId: string,
) {
  return join(handle.directory, `cancel-check-${artifactHash(jobId)}.json`);
}
export async function cancelCandidateVerification(
  handle: LocalAttemptHandle,
  jobId: string,
) {
  await privateDirectory(handle.directory);
  await writeSigned(
    verificationCancellationPath(handle, jobId),
    handle.attemptToken,
    { jobId, cancelled: true },
  );
}
export async function candidateVerificationCancelled(
  handle: LocalAttemptHandle,
  jobId: string,
) {
  try {
    const value = v.parse(
      v.strictObject({ jobId: v.string(), cancelled: v.literal(true) }),
      await readSigned(
        verificationCancellationPath(handle, jobId),
        handle.attemptToken,
      ),
    );
    if (value.jobId !== jobId) throw new Error('Cancellation binding mismatch');
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return false;
    throw error;
  }
}
export async function runSupervisedCandidateCheck(
  input: v.InferOutput<typeof candidateCheckInputSchema>,
  handle: LocalAttemptHandle,
  jobId: string,
  cancellationId = jobId,
) {
  input = v.parse(candidateCheckInputSchema, input);
  const job = v.parse(checkJobSchema, {
    jobId,
    cancellationId,
    request: input.workflow
      ? {
          ...input,
          workflow: {
            ...input.workflow,
            toolchain:
              input.workflow.toolchain ??
              (await discoverWorkflowToolchain(input.workflow.runtime)),
          },
        }
      : input,
  });
  if (!jobId || jobId.length > 500)
    throw new Error('A durable verification job ID is required');
  const requestHash = artifactHash(JSON.stringify(job));
  const directory = join(handle.directory, `check-${artifactHash(jobId)}`);
  await privateDirectory(handle.directory);
  if (await candidateVerificationCancelled(handle, cancellationId))
    throw new Error('Verification job cancelled');
  let created = false;
  try {
    await mkdir(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST'))
      throw error;
  }
  await privateDirectory(directory);
  if (created) {
    // Exclusive admission survives controller loss. Partial admission remains
    // uncertain and cannot be retried as another process.
    await atomicWrite(join(directory, 'token'), handle.attemptToken);
    await writeSigned(
      join(directory, 'request.json'),
      handle.attemptToken,
      job,
    );
    if (await candidateVerificationCancelled(handle, cancellationId))
      throw new Error('Verification job cancelled before spawn');
    const workerUrl = [
      './verification-worker.mjs',
      './assets/factory-delivery/verification-worker.mjs',
      './verification-worker.ts',
    ]
      .map((p) => new URL(p, import.meta.url))
      .find((url) => existsSync(url));
    if (!workerUrl)
      throw new Error('Verification worker asset missing; admission retained');
    const worker = fileURLToPath(workerUrl);
    const environment = await prepareCandidateCheckEnvironment(
      join(directory, 'environment'),
    );
    const loader = worker.endsWith('.ts')
      ? fileURLToPath(import.meta.resolve('tsx'))
      : null;
    let references: Record<string, string> = {};
    try {
      references = job.request.workflow
        ? workflowEnvironmentValues(job.request.workflow.environmentRefs)
        : {};
    } catch {
      /* Worker records the known missing/invalid-reference setup failure. */
    }
    const child = spawn(
      process.execPath,
      [...(loader ? ['--import', loader] : []), worker, directory],
      {
        cwd: directory,
        env: { ...environment.env, ...references },
        detached: true,
        stdio: 'ignore',
      },
    );
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
  } else {
    const existing = v.parse(
      checkJobSchema,
      await readSigned(join(directory, 'request.json'), handle.attemptToken),
    );
    if (JSON.stringify(existing) !== JSON.stringify(job))
      throw new Error('Verification job ID payload mismatch');
  }
  const deadline = Date.now() + job.request.timeoutMs + 5000;
  do {
    try {
      const receipt = v.parse(
        checkTerminalSchema,
        await readSigned(join(directory, 'terminal.json'), handle.attemptToken),
      );
      if (receipt.jobId !== jobId || receipt.requestHash !== requestHash)
        throw new Error('Verification receipt binding mismatch');
      return receipt.result;
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(
    'Verification worker completion is uncertain; retain durable ownership and do not replace',
  );
}

// Read-only recovery never creates a missing claim or starts a replacement.
export async function recoverExistingCandidateCheck(
  input: v.InferOutput<typeof candidateCheckInputSchema>,
  handle: LocalAttemptHandle,
  jobId: string,
  cancellationId = jobId,
) {
  const job = v.parse(checkJobSchema, {
    jobId,
    cancellationId,
    request: input,
  });
  const directory = join(handle.directory, `check-${artifactHash(jobId)}`);
  await privateDirectory(directory);
  const persisted = v.parse(
    checkJobSchema,
    await readSigned(join(directory, 'request.json'), handle.attemptToken),
  );
  if (
    persisted.request.timeoutMs > job.request.timeoutMs ||
    JSON.stringify({
      ...persisted,
      request: {
        ...persisted.request,
        timeoutMs: job.request.timeoutMs,
        ...(persisted.request.workflow
          ? {
              workflow: {
                ...persisted.request.workflow,
                toolchain: job.request.workflow?.toolchain,
              },
            }
          : {}),
      },
    }) !== JSON.stringify(job)
  )
    throw new Error('Verification recovery payload mismatch');
  const receipt = v.parse(
    checkTerminalSchema,
    await readSigned(join(directory, 'terminal.json'), handle.attemptToken),
  );
  if (
    receipt.jobId !== jobId ||
    receipt.requestHash !== artifactHash(JSON.stringify(persisted))
  )
    throw new Error('Verification receipt binding mismatch');
  return receipt.result;
}
