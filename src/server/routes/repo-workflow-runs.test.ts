import { expect, it, vi } from 'vitest';
import { runtimePaths } from '../../runtime-home';
import { createRepoWorkflowRunsRoutes } from './repo-workflow-runs';
it('routes explicit trial admission, inspection and cancellation through canonical services', async () => {
  const paths = runtimePaths('/tmp/trial-route-fixture');
  const io = {
    startRepoWorkflowRun: vi.fn().mockResolvedValue({ runId: 'run' }),
    getCurrentRepoWorkflowRun: vi.fn().mockResolvedValue({ run: null }),
    getRepoWorkflowRun: vi.fn().mockResolvedValue({ runId: 'run' }),
    cancelRepoWorkflowRun: vi
      .fn()
      .mockResolvedValue({ runId: 'run', status: 'cancelled' }),
  };
  const app = createRepoWorkflowRunsRoutes(paths, io);
  const current = await app.request(
    '/repos/sample/factory-workflow-runs/current',
  );
  expect(current.status).toBe(200);
  expect(await current.json()).toEqual({ run: null });
  expect(io.getCurrentRepoWorkflowRun).toHaveBeenCalledWith('sample', paths);
  expect(io.getRepoWorkflowRun).not.toHaveBeenCalled();
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
    getCurrentRepoWorkflowRun: vi.fn().mockResolvedValue({ run: null }),
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

it('current response schema accepts only null or a bounded public run', async () => {
  const v = await import('valibot');
  const { currentRepoWorkflowRunSchema } =
    await import('../../../shared/repo-workflow-runs');
  expect(v.safeParse(currentRepoWorkflowRunSchema, { run: null }).success).toBe(
    true,
  );
  expect(
    v.safeParse(currentRepoWorkflowRunSchema, {
      run: { runId: 'unsafe' },
      token: 'private',
    }).success,
  ).toBe(false);
});
