import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  read: vi.fn(),
  abort: vi.fn(async () => undefined),
}));
vi.mock('@flue/runtime', () => ({
  dispatch: mocks.dispatch,
  init: () => ({ read: mocks.read, abort: mocks.abort }),
}));
vi.mock('../runtime', () => ({
  readAgentModelSelectionSync: () => ({ utility: 'fixture-model' }),
}));
vi.mock('./proposal-agent', () => ({ RepoWorkflowProposer: () => undefined }));
import { runRepoWorkflowProposalModel } from './proposal-model';
import { runtimePaths } from '../../runtime-home';
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});
it('reads only the admitted submission and returns exactly one structured result', async () => {
  mocks.dispatch.mockResolvedValue({ submissionId: 'receipt' });
  mocks.read.mockResolvedValue({
    submissionId: 'receipt',
    data: { repoWorkflowProposal: [{ fixture: true }] },
  });
  expect(
    await runRepoWorkflowProposalModel([], runtimePaths('/tmp/fixture')),
  ).toEqual({ fixture: true });
  expect(mocks.read).toHaveBeenCalledWith(
    'receipt',
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});
it('rejects mismatched or multiple submitted results and requests abort', async () => {
  mocks.dispatch.mockResolvedValue({ submissionId: 'receipt' });
  mocks.read.mockResolvedValue({
    submissionId: 'other',
    data: { repoWorkflowProposal: [{}, {}] },
  });
  await expect(
    runRepoWorkflowProposalModel([], runtimePaths('/tmp/fixture')),
  ).rejects.toThrow(/one validated/);
  expect(mocks.abort).toHaveBeenCalledOnce();
});
it('bounds admission, and aborts again if admission arrives after expiry', async () => {
  vi.useFakeTimers();
  let admit: ((value: { submissionId: string }) => void) | undefined;
  mocks.dispatch.mockImplementation(
    () =>
      new Promise((resolve) => {
        admit = resolve;
      }),
  );
  const result = runRepoWorkflowProposalModel([], runtimePaths('/tmp/fixture'));
  const rejected = expect(result).rejects.toThrow(/deadline/);
  await vi.advanceTimersByTimeAsync(60_000);
  await rejected;
  admit?.({ submissionId: 'late' });
  await Promise.resolve();
  await Promise.resolve();
  expect(mocks.abort).toHaveBeenCalledTimes(2);
  expect(mocks.read).not.toHaveBeenCalled();
});
