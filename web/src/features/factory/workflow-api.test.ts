import { afterEach, expect, it, vi } from 'vitest';
import { getJson, putJson, postJson } from '../../api/http';
import {
  getRepoWorkflows,
  saveRepoWorkflows,
  proposeRepoWorkflows,
  getRepoWorkflowRun,
  startRepoWorkflowRun,
  cancelRepoWorkflowRun,
} from './workflow-api';
vi.mock('../../api/http', () => ({
  getJson: vi.fn(),
  putJson: vi.fn(),
  postJson: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());
it('validates repository identity and encoded config URLs', async () => {
  vi.mocked(getJson).mockResolvedValue({
    repoId: 'a/b',
    fingerprint: 'a'.repeat(64),
    workflows: null,
  });
  await getRepoWorkflows('a/b');
  expect(getJson).toHaveBeenCalledWith(
    '/api/repos/a%2Fb/factory-workflows',
    {},
  );
  await expect(getRepoWorkflows('other')).rejects.toThrow('another repository');
});
it('rejects malformed acknowledgements from every workflow boundary', async () => {
  vi.mocked(getJson).mockResolvedValue({});
  vi.mocked(putJson).mockResolvedValue({});
  vi.mocked(postJson).mockResolvedValue({});
  for (const call of [
    () => getRepoWorkflows('repo'),
    () =>
      saveRepoWorkflows('repo', {
        expectedFingerprint: 'a'.repeat(64),
        workflows: null,
      }),
    () => proposeRepoWorkflows('repo', 'a'.repeat(64)),
    () => getRepoWorkflowRun('repo', 'run'),
    () =>
      startRepoWorkflowRun('repo', {
        profileId: 'web',
        expectedFingerprint: 'a'.repeat(64),
      }),
    () => cancelRepoWorkflowRun('repo', 'run'),
  ])
    await expect(call()).rejects.toThrow();
});
it('rejects invalid saves before network mutation', async () => {
  await expect(
    saveRepoWorkflows('repo', {
      expectedFingerprint: 'stale',
      workflows: null,
    }),
  ).rejects.toThrow();
  expect(putJson).not.toHaveBeenCalled();
});
