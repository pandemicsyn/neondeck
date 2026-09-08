import { expect, it, vi } from 'vitest';
import { runtimePaths } from '../../runtime-home';
import { createRepoWorkflowRunsRoutes } from './repo-workflow-runs';
it('routes explicit trial admission, inspection and cancellation through canonical services', async () => {
  const paths = runtimePaths('/tmp/trial-route-fixture');
  const io = {
    startRepoWorkflowRun: vi.fn().mockResolvedValue({ runId: 'run' }),
    getRepoWorkflowRun: vi.fn().mockResolvedValue({ runId: 'run' }),
    cancelRepoWorkflowRun: vi
      .fn()
      .mockResolvedValue({ runId: 'run', status: 'cancelled' }),
  };
  const app = createRepoWorkflowRunsRoutes(paths, io);
  const input = { profileId: 'web', expectedFingerprint: 'a'.repeat(64) };
  expect(
    (
      await app.request('/repos/sample/factory-workflow-runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
    ).status,
  ).toBe(202);
  expect(io.startRepoWorkflowRun).toHaveBeenCalledWith('sample', input, paths);
  expect(
    (await app.request('/repos/sample/factory-workflow-runs/run')).status,
  ).toBe(200);
  expect(io.getRepoWorkflowRun).toHaveBeenCalledWith('sample', 'run', paths);
  expect(
    (
      await app.request('/repos/sample/factory-workflow-runs/run/cancel', {
        method: 'POST',
      })
    ).status,
  ).toBe(200);
  expect(io.cancelRepoWorkflowRun).toHaveBeenCalledWith('sample', 'run', paths);
});
it('rejects malformed JSON before service admission', async () => {
  const io = {
    startRepoWorkflowRun: vi.fn(),
    getRepoWorkflowRun: vi.fn(),
    cancelRepoWorkflowRun: vi.fn(),
  };
  const app = createRepoWorkflowRunsRoutes(
    runtimePaths('/tmp/trial-route-fixture'),
    io,
  );
  expect(
    (
      await app.request('/repos/sample/factory-workflow-runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      })
    ).status,
  ).toBe(400);
  expect(io.startRepoWorkflowRun).not.toHaveBeenCalled();
});
