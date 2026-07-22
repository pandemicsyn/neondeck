import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimePaths } from './runtime-home';
import { createWorkflowRoutes } from './server/routes/workflows';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('workflow run inspection routes', () => {
  it('returns structured app-owned run data', async () => {
    const paths = runtimePaths(await tempHome());
    const app = new Hono().route(
      '/api/workflows',
      createWorkflowRoutes(paths, {
        getRun: async (runId) => ({
          runId,
          workflowName: 'command-run',
          status: 'completed',
          startedAt: '2026-07-21T16:00:00.000Z',
          endedAt: '2026-07-21T16:00:01.250Z',
          durationMs: 1_250,
          isError: false,
          input: { command: '/review-queue' },
          result: { ok: true },
        }),
      }),
    );

    const response = await app.request('/api/workflows/runs/run_123');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      action: 'workflow_run_inspection_read',
      run: {
        runId: 'run_123',
        workflowName: 'command-run',
        status: 'completed',
        result: { ok: true },
      },
    });
  });

  it('returns not found without exposing another run', async () => {
    const paths = runtimePaths(await tempHome());
    const app = new Hono().route(
      '/api/workflows',
      createWorkflowRoutes(paths, { getRun: async () => null }),
    );

    const response = await app.request('/api/workflows/runs/missing');
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: 'Workflow run not found.',
    });
  });
});

async function tempHome() {
  const path = await mkdtemp(join(tmpdir(), 'neondeck-workflow-routes-'));
  tempRoots.push(path);
  return path;
}
