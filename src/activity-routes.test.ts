import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordFlueObservation } from './modules/learning';
import { runtimePaths } from './runtime-home';
import { createActivityRoutes } from './server/routes/activity';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('activity routes', () => {
  it('returns sanitized activity and submission detail without raw Flue runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neondeck-activity-routes-'));
    roots.push(root);
    const paths = runtimePaths(root);
    await recordFlueObservation(
      {
        v: 3,
        type: 'submission_queued',
        eventIndex: 1,
        timestamp: '2026-08-01T10:00:00.000Z',
        submissionId: 'submission/1',
        agentName: 'display-assistant',
        instanceId: 'session-1',
        kind: 'dispatch',
      },
      paths,
    );
    const routes = createActivityRoutes(paths);

    const overview = await routes.request('http://localhost/');
    expect(overview.status).toBe(200);
    await expect(overview.json()).resolves.toMatchObject({
      activeSubmissions: [{ submissionId: 'submission/1' }],
    });

    const detail = await routes.request(
      'http://localhost/submissions/submission%2F1',
    );
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      action: 'activity_submission_read',
      submission: { submissionId: 'submission/1' },
      events: [{ eventType: 'submission_queued' }],
    });
  });

  it('validates incremental cursors and returns 404 for unknown submissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neondeck-activity-routes-'));
    roots.push(root);
    const routes = createActivityRoutes(runtimePaths(root));
    expect(
      (
        await routes.request(
          'http://localhost/submissions/missing?afterEventId=-1',
        )
      ).status,
    ).toBe(400);
    expect(
      (await routes.request('http://localhost/submissions/missing')).status,
    ).toBe(404);
  });
});
