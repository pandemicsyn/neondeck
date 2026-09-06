import { artifactHash, writeSigned } from '../coding-runs';
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  candidateEvidenceFixture as fixture,
  candidateEvidenceFixtureRoots as roots,
} from './evidence-fixture';
import { captureCandidateEvidence } from './evidence';
import { verifyCandidateEvidence } from './verification';
import type { checkExecutionPolicy } from '../execution';
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const checkPolicy: typeof checkExecutionPolicy = async (input) =>
  ({
    command: (input as { command: string }).command,
    backend: 'local',
    context: 'unattended',
    decision: 'allow',
    risk: 'read-only',
    reason: 'fixture',
    ok: true,
    action: 'execution_policy_check',
    changed: false,
  }) as Awaited<ReturnType<typeof checkExecutionPolicy>>;
async function setup() {
  const f = await fixture();
  const evidence = await captureCandidateEvidence(f.handle);
  const verificationRoot = join(f.source, '..', 'check');
  f.git(f.source, [
    'worktree',
    'add',
    '--detach',
    verificationRoot,
    evidence.headSha,
  ]);
  await writeFile(join(verificationRoot, 'a.txt'), 'candidate\n');
  await writeFile(join(verificationRoot, 'new.txt'), 'new\n');
  return {
    ...f,
    input: {
      handle: f.handle,
      evidence,
      verificationRoot,
      jobId: 'verify-fixture',
      checks: ['/usr/bin/true'],
      timeoutMs: 1000,
      maxOutputBytes: 1000,
      remainingMs: 60000,
    },
  };
}
const good = () =>
  Promise.resolve({
    exitCode: 0,
    truncated: false,
    timedOut: false,
    cancelled: false,
    noWriter: true,
    durationMs: 1,
    stdout: 'checked\n',
    stderr: '',
  });
it('persists actual bounded check evidence and rejects no-check certification', async () => {
  const { input } = await setup();
  const result = await verifyCandidateEvidence(input, undefined, {
    checkPolicy,
    runCheck: good,
  });
  expect(result).toMatchObject({
    passed: true,
    noWriter: true,
    checks: [
      {
        exitCode: 0,
        outputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        evidenceRef: expect.any(String),
      },
    ],
  });
  await expect(
    verifyCandidateEvidence({ ...input, checks: [] }, undefined, {
      checkPolicy,
      runCheck: good,
    }),
  ).rejects.toThrow();
});
it('blocks truncated output and unproven process death', async () => {
  const { input } = await setup();
  expect(
    await verifyCandidateEvidence(input, undefined, {
      checkPolicy,
      runCheck: async () => ({ ...(await good()), truncated: true }),
    }),
  ).toMatchObject({ passed: false });
  await expect(
    verifyCandidateEvidence(input, undefined, {
      checkPolicy,
      runCheck: async () => ({ ...(await good()), noWriter: false }),
    }),
  ).rejects.toThrow('death');
});
it('rejects a check that changes frozen evidence and original checkout reuse', async () => {
  const { input } = await setup();
  await expect(
    verifyCandidateEvidence(
      { ...input, verificationRoot: input.evidence.root },
      undefined,
      { checkPolicy, runCheck: good },
    ),
  ).rejects.toThrow('separate');
  const result = await verifyCandidateEvidence(input, undefined, {
    checkPolicy,
    runCheck: async () => {
      await writeFile(join(input.verificationRoot, 'a.txt'), 'changed\n');
      return good();
    },
  });
  expect(result).toMatchObject({
    passed: false,
    noWriter: true,
    checks: [{ passed: false, exitCode: 0 }],
  });
  expect(
    JSON.parse(await readFile(result.checks[0].evidenceRef!, 'utf8')),
  ).toMatchObject({
    mutation: {
      reason: 'Check changed certified checkout contents',
      expectedTreeSha: input.evidence.treeSha,
    },
  });
  expect(await readFile(join(input.evidence.root, 'a.txt'), 'utf8')).toBe(
    'candidate\n',
  );
});
it('read-only recovery cannot create a missing job', async () => {
  const { input } = await setup();
  await expect(
    verifyCandidateEvidence({ ...input, recoverOnly: true }, undefined, {
      checkPolicy,
    }),
  ).rejects.toThrow();
});

it('does not certify a legacy signed terminal without private environment attestation', async () => {
  const { input } = await setup();
  const jobId = `${input.jobId}:0`;
  const job = {
    jobId,
    cancellationId: input.jobId,
    request: {
      command: input.checks[0],
      cwd: input.verificationRoot,
      timeoutMs: input.timeoutMs,
      maxOutputBytes: input.maxOutputBytes,
    },
  };
  const directory = join(
    input.handle.directory,
    `check-${artifactHash(jobId)}`,
  );
  await mkdir(directory, { mode: 0o700 });
  await writeSigned(
    join(directory, 'request.json'),
    input.handle.attemptToken,
    job,
  );
  await writeSigned(
    join(directory, 'terminal.json'),
    input.handle.attemptToken,
    {
      jobId,
      requestHash: artifactHash(JSON.stringify(job)),
      result: await good(),
    },
  );
  expect(
    await verifyCandidateEvidence({ ...input, recoverOnly: true }, undefined, {
      checkPolicy,
    }),
  ).toMatchObject({ passed: false, noWriter: true });
});
