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
    let eventQuery: { afterEventId?: number } | undefined;
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
        readRunEvents: async (runId, _paths, query) => {
          eventQuery = query;
          return {
            events: [
              {
                id: 1,
                runId,
                workflow: 'command-run',
                eventType: 'run_start',
                eventIndex: 1,
                level: null,
                message: 'Started workflow command-run.',
                name: 'command-run',
                operationKind: null,
                operationId: null,
                agentName: null,
                instanceId: null,
                durationMs: null,
                isError: false,
                summary: { workflowName: 'command-run' },
                createdAt: '2026-07-21T16:00:00.000Z',
                runUrl: '/workflow-run?runId=run_123',
              },
            ],
            totalEventCount: 2,
            retainedEventCount: 1,
            isTruncated: true,
          };
        },
      }),
    );

    const response = await app.request(
      '/api/workflows/runs/run_123?afterEventId=41',
    );
    expect(response.status).toBe(200);
    expect(eventQuery).toEqual({ afterEventId: 41 });
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      action: 'workflow_run_inspection_read',
      run: {
        runId: 'run_123',
        workflowName: 'command-run',
        status: 'completed',
        result: { ok: true },
      },
      events: [
        expect.objectContaining({
          runId: 'run_123',
          eventType: 'run_start',
        }),
      ],
      eventHistory: {
        totalEventCount: 2,
        retainedEventCount: 1,
        isTruncated: true,
      },
    });
  });

  it('rejects an invalid incremental event cursor', async () => {
    const paths = runtimePaths(await tempHome());
    let readRun = false;
    const app = new Hono().route(
      '/api/workflows',
      createWorkflowRoutes(paths, {
        getRun: async () => {
          readRun = true;
          return null;
        },
      }),
    );

    const response = await app.request(
      '/api/workflows/runs/run_123?afterEventId=1.5',
    );
    expect(response.status).toBe(400);
    expect(readRun).toBe(false);
    await expect(response.json()).resolves.toEqual({
      error: 'afterEventId must be a non-negative integer.',
    });
  });

  it('returns not found without exposing another run', async () => {
    const paths = runtimePaths(await tempHome());
    let readEvents = false;
    const app = new Hono().route(
      '/api/workflows',
      createWorkflowRoutes(paths, {
        getRun: async () => null,
        readRunEvents: async () => {
          readEvents = true;
          return {
            events: [],
            totalEventCount: 0,
            retainedEventCount: 0,
            isTruncated: false,
          };
        },
      }),
    );

    const response = await app.request('/api/workflows/runs/missing');
    expect(response.status).toBe(404);
    expect(readEvents).toBe(false);
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
