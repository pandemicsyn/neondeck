import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { it, expect } from 'vitest';
import { claimProgressModelResponse } from './progress-reviewer-admission';
import { progressDigest } from './progress-evidence-contract';
import { progressFailureFingerprint } from './progress-evidence-fingerprint';
it('durable model claim remains consumed for another submission or restart', () => {
  const home = mkdtempSync(join(tmpdir(), 'progress-admission-'));
  try {
    claimProgressModelResponse(
      { instanceId: 'assessment-one', submissionId: 'submission-one' },
      home,
    );
    expect(() =>
      claimProgressModelResponse(
        { instanceId: 'assessment-one', submissionId: 'submission-one' },
        home,
      ),
    ).toThrow();
    expect(() =>
      claimProgressModelResponse(
        { instanceId: 'assessment-one', submissionId: 'replacement' },
        home,
      ),
    ).toThrow();
    expect(() =>
      claimProgressModelResponse(
        { instanceId: 'assessment-two', submissionId: 'submission-two' },
        home,
      ),
    ).not.toThrow();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
it('failure fingerprints ignore transport/revision/time noise but preserve changed failures', () => {
  const first = {
    revision: 'aaa',
    durationMs: 12,
    findings: [
      {
        id: 1,
        description: 'Expected 2 got 1',
        updatedAt: '2026-09-01T00:00:00Z',
      },
    ],
  };
  const second = {
    revision: 'bbb',
    durationMs: 44,
    findings: [
      {
        id: 2,
        description: 'Expected 2 got 1',
        updatedAt: '2026-09-02T00:00:00Z',
      },
    ],
  };
  expect(progressFailureFingerprint(first)).toBe(
    progressFailureFingerprint(second),
  );
  expect(progressFailureFingerprint(first)).not.toBe(
    progressFailureFingerprint({
      ...second,
      findings: [{ description: 'Expected 2 got 0' }],
    }),
  );
});

it('concurrent admission requests have exactly one winner', async () => {
  const home = mkdtempSync(join(tmpdir(), 'progress-admission-race-'));
  try {
    const claims = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        Promise.resolve().then(() =>
          claimProgressModelResponse(
            { instanceId: 'one-ordinal', submissionId: `submission-${i}` },
            home,
          ),
        ),
      ),
    );
    expect(claims.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(claims.filter((r) => r.status === 'rejected')).toHaveLength(11);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
it('interruption after exclusive creation and before receipt completion cannot readmit', () => {
  const home = mkdtempSync(join(tmpdir(), 'progress-admission-interrupted-'));
  try {
    const directory = join(home, 'factory-progress-model-admissions');
    mkdirSync(directory);
    writeFileSync(
      join(directory, `${progressDigest('interrupted')}.json`),
      '',
      { flag: 'wx' },
    );
    expect(() =>
      claimProgressModelResponse(
        { instanceId: 'interrupted', submissionId: 'replacement' },
        home,
      ),
    ).toThrow(/allowance consumed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
it('an invalid identity cannot reserve or substitute an existing assessment', () => {
  const home = mkdtempSync(join(tmpdir(), 'progress-admission-invalid-'));
  try {
    expect(() =>
      claimProgressModelResponse(
        { instanceId: '', submissionId: 'replacement' },
        home,
      ),
    ).toThrow();
    claimProgressModelResponse(
      { instanceId: 'original', submissionId: 'first' },
      home,
    );
    expect(() =>
      claimProgressModelResponse(
        { instanceId: 'original', submissionId: 'new-incarnation' },
        home,
      ),
    ).toThrow();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
