import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { log } from '@clack/prompts';
import { runFactoryWorkflowTrial } from './onboarding-factory-workflow-trial';
import {
  startRepoWorkflowRun,
  getRepoWorkflowRun,
  cancelRepoWorkflowRun,
} from '../modules/repo-workflow-runs';
import { runtimePaths } from '../runtime-home';
import type { RepoWorkflowRun } from '../../shared/repo-workflow-runs';
vi.mock('@clack/prompts', () => ({ log: { info: vi.fn() } }));
vi.mock('../modules/repo-workflow-runs', () => ({
  startRepoWorkflowRun: vi.fn(),
  getRepoWorkflowRun: vi.fn(),
  cancelRepoWorkflowRun: vi.fn(),
}));
const paths = runtimePaths('/tmp/cli-workflow-trial-test');
const running = (): RepoWorkflowRun => ({
  runId: 'owned-trial',
  repoId: 'demo',
  profileId: 'web',
  workflowFingerprint: 'a'.repeat(64),
  status: 'running',
  phase: 'setup',
  baseSha: null,
  logs: [],
  cleanup: 'pending',
  guidance: '',
  startedAt: '2026-09-07T00:00:00.000Z',
  finishedAt: null,
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(startRepoWorkflowRun).mockResolvedValue(running());
});
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});
it('prints setup and check progress from the shared service without executing commands itself', async () => {
  vi.mocked(getRepoWorkflowRun).mockResolvedValue({
    ...running(),
    status: 'passed',
    phase: 'complete',
    cleanup: 'complete',
    logs: [
      {
        phase: 'setup',
        command: 'fixture-setup',
        cwd: '.',
        exitCode: 0,
        output: 'Fixture dependencies prepared',
        durationMs: 5,
        truncated: false,
      },
    ],
  });
  const promise = runFactoryWorkflowTrial('demo', 'web', 'a'.repeat(64), paths);
  await vi.advanceTimersByTimeAsync(600);
  await expect(promise).resolves.toMatchObject({ status: 'passed' });
  expect(log.info).toHaveBeenCalledWith(
    expect.stringContaining('Fixture dependencies prepared'),
  );
  expect(cancelRepoWorkflowRun).not.toHaveBeenCalled();
});
it('cancels owned trials on Ctrl+C and waits for terminal cleanup', async () => {
  const count = process.listenerCount('SIGINT');
  vi.mocked(cancelRepoWorkflowRun).mockResolvedValue(running());
  vi.mocked(getRepoWorkflowRun).mockResolvedValue({
    ...running(),
    status: 'cancelled',
    phase: 'complete',
    cleanup: 'complete',
  });
  const promise = runFactoryWorkflowTrial('demo', 'web', 'a'.repeat(64), paths);
  await vi.advanceTimersByTimeAsync(0);
  process.emit('SIGINT');
  await vi.advanceTimersByTimeAsync(600);
  await expect(promise).resolves.toMatchObject({ status: 'cancelled' });
  expect(cancelRepoWorkflowRun).toHaveBeenCalledWith(
    'demo',
    'owned-trial',
    paths,
  );
  expect(process.listenerCount('SIGINT')).toBe(count);
});
it('reports the retained run handle when status and cancellation cannot be confirmed', async () => {
  vi.mocked(getRepoWorkflowRun).mockRejectedValue(new Error('Unavailable'));
  vi.mocked(cancelRepoWorkflowRun).mockRejectedValue(new Error('Unavailable'));
  const result = runFactoryWorkflowTrial(
    'demo',
    'web',
    'a'.repeat(64),
    paths,
  ).catch((error) => error);
  await vi.advanceTimersByTimeAsync(2200);
  expect(await result).toBeInstanceOf(Error);
  expect(log.info).toHaveBeenCalledWith(
    expect.stringContaining('Retained run ID: owned-trial'),
  );
});
it('keeps observing a cancelled test until pending cleanup completes', async () => {
  const pending: RepoWorkflowRun = {
    ...running(),
    status: 'cancelled',
    phase: 'cleanup',
  };
  vi.mocked(cancelRepoWorkflowRun).mockResolvedValue(pending);
  vi.mocked(getRepoWorkflowRun)
    .mockResolvedValueOnce(pending)
    .mockResolvedValue({ ...pending, phase: 'complete', cleanup: 'complete' });
  let settled = false;
  const promise = runFactoryWorkflowTrial(
    'demo',
    'web',
    'a'.repeat(64),
    paths,
  ).then((result) => {
    settled = true;
    return result;
  });
  await vi.advanceTimersByTimeAsync(0);
  process.emit('SIGINT');
  await vi.advanceTimersByTimeAsync(600);
  expect(settled).toBe(false);
  expect(log.info).toHaveBeenCalledWith('Cleaning up test checkout');
  await vi.advanceTimersByTimeAsync(500);
  await expect(promise).resolves.toMatchObject({
    phase: 'complete',
    cleanup: 'complete',
  });
  expect(cancelRepoWorkflowRun).toHaveBeenCalledOnce();
  expect(getRepoWorkflowRun).toHaveBeenCalledTimes(2);
});
it('returns an actionable retained outcome without polling indefinitely', async () => {
  vi.mocked(getRepoWorkflowRun).mockResolvedValue({
    ...running(),
    status: 'uncertain',
    phase: 'cleanup',
    cleanup: 'retained',
    guidance: 'Inspect retained checkout.',
  });
  const promise = runFactoryWorkflowTrial('demo', 'web', 'a'.repeat(64), paths);
  await vi.advanceTimersByTimeAsync(600);
  await expect(promise).resolves.toMatchObject({
    status: 'uncertain',
    cleanup: 'retained',
  });
});
