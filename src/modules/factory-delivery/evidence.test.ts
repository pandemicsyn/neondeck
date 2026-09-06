import { writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { writeSigned, readSigned, artifactHash } from '../coding-runs';
import {
  captureCandidateEvidence,
  candidateEvidenceRetentionRef,
  assertCandidateEvidenceCurrent,
} from './evidence';
import {
  candidateEvidenceFixture as fixture,
  candidateEvidenceFixtureRoots as roots,
} from './evidence-fixture';
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
it('captures immutable raw tracked/untracked tree without moving HEAD or real index', async () => {
  const f = await fixture();
  const before = f.git(f.root, ['status', '--porcelain=v1']);
  const evidence = await captureCandidateEvidence(f.handle);
  expect(evidence.treeSha).toBe(evidence.revision);
  expect(f.git(f.root, ['show', `${evidence.treeSha}:new.txt`])).toBe('new\n');
  expect(f.git(f.root, ['show', `${evidence.treeSha}:a.txt`])).toBe(
    'candidate\n',
  );
  expect(f.git(f.root, ['rev-parse', 'HEAD']).trim()).toBe(evidence.headSha);
  expect(f.git(f.root, ['status', '--porcelain=v1'])).toBe(before);
  expect(
    (await assertCandidateEvidenceCurrent(f.handle, evidence)).evidenceDigest,
  ).toBe(evidence.evidenceDigest);
  await expect(
    assertCandidateEvidenceCurrent(f.handle, {
      ...evidence,
      evidenceDigest: '0'.repeat(64),
    }),
  ).rejects.toThrow('digest');
});
it.each(['a.txt', 'new.txt'])(
  'rejects same-status content drift in %s',
  async (name) => {
    const f = await fixture();
    const evidence = await captureCandidateEvidence(f.handle);
    await writeFile(join(f.root, name), 'changed but same status\n');
    await expect(
      assertCandidateEvidenceCurrent(f.handle, evidence),
    ).rejects.toThrow('Stale candidate');
  },
);
it('rejects executable-mode drift and authenticated artifact tampering', async () => {
  const f = await fixture();
  const evidence = await captureCandidateEvidence(f.handle);
  await chmod(join(f.root, 'new.txt'), 0o755);
  await expect(
    assertCandidateEvidenceCurrent(f.handle, evidence),
  ).rejects.toThrow('Stale candidate');
  await writeFile(f.result.diffRef, 'tampered');
  await expect(captureCandidateEvidence(f.handle)).rejects.toThrow('integrity');
});
it('rejects malformed signed candidate and executable Git filters', async () => {
  const f = await fixture();
  await writeSigned(
    join(f.handle.directory, 'candidate.json'),
    f.handle.attemptToken,
    { version: 1 },
  );
  await expect(captureCandidateEvidence(f.handle)).rejects.toThrow();
  f.git(f.root, ['config', 'filter.fixture.clean', '/usr/bin/false']);
  await expect(captureCandidateEvidence(f.handle)).rejects.toThrow('filters');
});

it('rejects untracked chmod between retained collection and first freeze', async () => {
  const f = await fixture();
  await chmod(join(f.root, 'new.txt'), 0o755);
  await expect(captureCandidateEvidence(f.handle)).rejects.toThrow(
    'Stale candidate',
  );
});

it('blocks legacy retained untracked evidence whose original mode is unproven', async () => {
  const f = await fixture();
  const entries = JSON.parse(await readFile(f.result.untrackedRef, 'utf8'));
  delete entries[0].mode;
  const bytes = JSON.stringify(entries);
  await writeFile(f.result.untrackedRef, bytes);
  const candidate = (await readSigned(
    join(f.handle.directory, 'candidate.json'),
    f.handle.attemptToken,
  )) as { hashes: { untracked: string } };
  candidate.hashes.untracked = artifactHash(bytes);
  await writeSigned(
    join(f.handle.directory, 'candidate.json'),
    f.handle.attemptToken,
    candidate,
  );
  await expect(captureCandidateEvidence(f.handle)).rejects.toThrow(
    'mode is unproven',
  );
});

it('retains frozen trees across GC before publication and refuses ref takeover', async () => {
  const f = await fixture();
  const evidence = await captureCandidateEvidence(f.handle);
  const ref = candidateEvidenceRetentionRef(evidence);
  expect(ref.startsWith('refs/neondeck/evidence/v1/')).toBe(true);
  expect(f.git(f.root, ['rev-parse', ref]).trim()).toBe(evidence.treeSha);
  f.git(f.root, ['reflog', 'expire', '--expire=now', '--all']);
  f.git(f.root, ['gc', '--prune=now']);
  expect(f.git(f.root, ['show', `${evidence.treeSha}:new.txt`])).toBe('new\n');
  expect((await captureCandidateEvidence(f.handle)).evidenceDigest).toBe(
    evidence.evidenceDigest,
  );
  f.git(f.root, ['update-ref', ref, `${evidence.headSha}^{tree}`]);
  await expect(captureCandidateEvidence(f.handle)).rejects.toThrow(
    'retention ref ownership',
  );
});
