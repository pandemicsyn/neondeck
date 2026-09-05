import { afterEach, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import * as api from '../../api/factory';
import { factoryDetailSchema } from '../../../../shared/factory';
import { factoryDetailViewSchema } from '../../../../shared/factory-api';
vi.mock('../../api/http', () => ({ getJson: vi.fn(), postJson: vi.fn() }));
import { getJson, postJson } from '../../api/http';
afterEach(() => vi.resetAllMocks());
const acknowledgements = [
  () => api.setFactoryEnabled(true),
  () => api.recoverFactoryPlanning('task'),
  () => api.refreshFactoryPlanningContext('task', 1),
  () => api.stopFactoryPlanning('session'),
  () => api.retryFactoryTriage('task'),
  () => api.saveFactoryGitHub([], 'hash'),
  () => api.syncFactorySource('task'),
  () =>
    api.setFactoryWriteback('connection', {
      enabled: true,
      expectedEpoch: 'epoch',
      expectedFingerprint: 'hash',
    }),
  () =>
    api.approveFactoryWriteback('task', {
      requestKey: 'r',
      expectedVersion: 1,
      specVersion: 1,
      specHash: 'hash',
      sourceVersion: 1,
      issueId: 'issue',
      kind: 'summary',
      body: 'Reviewed',
      decisionId: null,
    }),
  () => api.recoverFactoryWriteback('task', 'effect', 'retry'),
  () => api.approveFactoryWritebackRepair('task', 'preview', 'Reviewed'),
];
it.each(acknowledgements)(
  'rejects malformed successful mutation acknowledgement %#',
  async (operation) => {
    vi.mocked(postJson).mockResolvedValue({ unexpected: 'response' });
    await expect(operation()).rejects.toThrow();
  },
);
it('accepts the documented idle abort and accepted sync responses', async () => {
  vi.mocked(postJson)
    .mockResolvedValueOnce({ aborted: false })
    .mockResolvedValueOnce({ accepted: true });
  await expect(api.stopFactoryPlanning('session')).resolves.toEqual({
    aborted: false,
  });
  await expect(api.syncFactorySource('task')).resolves.toEqual({
    accepted: true,
  });
});
it('requires revisions at the view boundary without changing internal snapshot semantics', async () => {
  // Isolate the changed collection contract; complete record contracts remain shared.
  expect(v.safeParse(factoryDetailSchema.entries.revisions, []).success).toBe(
    true,
  );
  expect(
    v.safeParse(factoryDetailViewSchema.entries.revisions, []).success,
  ).toBe(false);
  vi.mocked(getJson).mockResolvedValue({ revisions: [] });
  await expect(api.getFactoryDetail('task')).rejects.toThrow();
});
