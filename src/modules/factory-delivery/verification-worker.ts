import { join, dirname } from 'node:path';
import * as v from 'valibot';
import { executionResult } from '../execution/worker.ts';
import {
  artifactHash,
  privateDirectory,
  readBytesBounded,
  readSigned,
  writeSigned,
} from '../coding-runs/worker.ts';
import {
  runCandidateCheck,
  CheckEnvironmentSetupError,
} from './verification-process.ts';
import {
  candidateVerificationCancelled,
  checkJobSchema,
} from './verification-supervisor.ts';

// This detached process owns the clock and process group after controller loss.
const directory = process.argv[2];
if (!directory) throw new Error('Verification worker directory is required');
await privateDirectory(directory);
const token = v.parse(
  v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  (await readBytesBounded(join(directory, 'token'), 64)).toString('utf8'),
);
const job = v.parse(
  checkJobSchema,
  await readSigned(join(directory, 'request.json'), token),
);
const handle = { directory: dirname(directory), attemptToken: token };
const cancellation = new AbortController();
let polling = true;
let timer: ReturnType<typeof setTimeout> | undefined;
async function poll() {
  try {
    if (await candidateVerificationCancelled(handle, job.cancellationId))
      cancellation.abort();
  } catch {
    cancellation.abort();
  }
  if (polling && !cancellation.signal.aborted)
    timer = setTimeout(() => void poll(), 100);
}
await poll();
await writeSigned(join(directory, 'started.json'), token, {
  pid: process.pid,
  startedAt: Date.now(),
  jobId: job.jobId,
});
let result;
const executionStarted = Date.now();
try {
  result = await runCandidateCheck(job.request, {
    signal: cancellation.signal,
    jobDirectory: join(directory, 'environment'),
  });
} catch (error) {
  result = {
    setupBlocked: error instanceof CheckEnvironmentSetupError,
    exitCode: null,
    truncated: false,
    durationMs: Date.now() - executionStarted,
    noWriter: error instanceof CheckEnvironmentSetupError,
    timedOut: false,
    cancelled: cancellation.signal.aborted,
    stdout: '',
    stderr:
      error instanceof CheckEnvironmentSetupError
        ? error.message
        : 'Verification worker could not prove successful completion.',
  };
} finally {
  polling = false;
  clearTimeout(timer);
}
const sanitized = executionResult({
  ...result,
  outputLimit: job.request.maxOutputBytes,
});
await writeSigned(join(directory, 'terminal.json'), token, {
  jobId: job.jobId,
  requestHash: artifactHash(JSON.stringify(job)),
  result: { ...result, stdout: sanitized.stdout, stderr: sanitized.stderr },
});
