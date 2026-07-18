import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import {
  reviewSourceSchemaVersion,
  resolvedReviewRevision,
} from '../shared/review-source';
import {
  reviewSurfaceSchemaVersion,
  type ReviewSurfaceChangeEvent,
  type ReviewSurfaceSnapshot,
} from '../shared/review-surface';
import { ReviewSurfaceRegistry } from './modules/review-surfaces';
import { createReviewSurfaceRoutes } from './server/routes/review-surfaces';

const registries: ReviewSurfaceRegistry[] = [];

afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
});

describe('review surface registry', () => {
  it('keeps two mounts of one source independently addressable', async () => {
    const { app, registry } = harness();
    await register(app, snapshot('surface-a'));
    await register(app, snapshot('surface-b'));

    const response = await app.request('http://localhost/api/review-surfaces');
    const body = (await response.json()) as {
      surfaces: Array<{ surfaceId: string; source: { id: string } }>;
    };

    expect(response.status).toBe(200);
    expect(body.surfaces).toHaveLength(2);
    expect(body.surfaces.map((surface) => surface.surfaceId).sort()).toEqual([
      'surface-a',
      'surface-b',
    ]);
    expect(new Set(body.surfaces.map((surface) => surface.source.id))).toEqual(
      new Set(['github-pr:example/repo#42']),
    );
    expect(registry.list()).toHaveLength(2);
  });

  it('publishes targeted navigation and records the surface acknowledgement', async () => {
    const { app, registry } = harness();
    const events: ReviewSurfaceChangeEvent[] = [];
    registry.subscribe((event) => events.push(event));
    await register(app, snapshot('surface-a'));

    const navigateResponse = await app.request(
      'http://localhost/api/review-surfaces/surface-a/navigation',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          revisionKey: 'git-commit::head-sha',
          target: { path: 'src/app.ts', focus: false },
        }),
      },
    );
    const navigationBody = (await navigateResponse.json()) as {
      navigation: { commandId: string };
    };
    const commandId = navigationBody.navigation.commandId;
    const ackResponse = await app.request(
      `http://localhost/api/review-surfaces/surface-a/navigation/${commandId}/ack`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          status: 'resolved',
          revisionKey: 'git-commit::head-sha',
          resolvedPath: 'src/app.ts',
          message: null,
        }),
      },
    );

    expect(navigateResponse.status).toBe(200);
    expect(ackResponse.status).toBe(200);
    const duplicateAckResponse = await app.request(
      `http://localhost/api/review-surfaces/surface-a/navigation/${commandId}/ack`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          status: 'resolved',
          revisionKey: 'git-commit::head-sha',
          resolvedPath: 'src/app.ts',
          message: null,
        }),
      },
    );
    expect(duplicateAckResponse.status).toBe(404);
    expect(events.map((event) => event.action)).toEqual([
      'registered',
      'navigation',
      'acknowledged',
    ]);
    expect(registry.read('surface-a')?.lastNavigationAck).toMatchObject({
      commandId,
      status: 'resolved',
      resolvedPath: 'src/app.ts',
    });
  });

  it('expires inactive surfaces without durable state', () => {
    let now = Date.parse('2026-07-18T00:00:00.000Z');
    const registry = new ReviewSurfaceRegistry({ now: () => now, ttlMs: 100 });
    registries.push(registry);
    const events: ReviewSurfaceChangeEvent[] = [];
    registry.subscribe((event) => events.push(event));
    registry.upsert(snapshot('surface-a'));

    now += 101;

    expect(registry.list()).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      action: 'removed',
      surfaceId: 'surface-a',
      reason: 'expired',
    });
  });

  it('refreshes expiry without rebroadcasting or returning the full context', async () => {
    let now = Date.parse('2026-07-18T00:00:00.000Z');
    const registry = new ReviewSurfaceRegistry({ now: () => now, ttlMs: 100 });
    registries.push(registry);
    const app = new Hono().route('/api', createReviewSurfaceRoutes(registry));
    const events: ReviewSurfaceChangeEvent[] = [];
    registry.subscribe((event) => events.push(event));
    const registered = registry.upsert(snapshot('surface-a'));

    now += 50;
    const response = await app.request(
      'http://localhost/api/review-surfaces/surface-a/heartbeat',
      { method: 'POST' },
    );
    const heartbeat = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(heartbeat.expiresAt).not.toBe(registered.expiresAt);
    expect(heartbeat).not.toHaveProperty('surface');
    expect(heartbeat).not.toHaveProperty('source');
    expect(events.map((event) => event.action)).toEqual(['registered']);
    expect(events[0]?.surface).toBeNull();
  });

  it('rejects a route/body surface mismatch', async () => {
    const { app } = harness();
    const response = await app.request(
      'http://localhost/api/review-surfaces/surface-a',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(snapshot('surface-b')),
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      message: 'Surface id does not match the route.',
    });
  });
});

function harness() {
  const registry = new ReviewSurfaceRegistry();
  registries.push(registry);
  return {
    app: new Hono().route('/api', createReviewSurfaceRoutes(registry)),
    registry,
  };
}

async function register(app: Hono, value: ReviewSurfaceSnapshot) {
  const response = await app.request(
    `http://localhost/api/review-surfaces/${value.surfaceId}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(value),
    },
  );
  expect(response.status).toBe(200);
}

function snapshot(surfaceId: string): ReviewSurfaceSnapshot {
  return {
    schemaVersion: reviewSurfaceSchemaVersion,
    surfaceId,
    source: {
      schemaVersion: reviewSourceSchemaVersion,
      id: 'github-pr:example/repo#42',
      kind: 'github-pr',
      title: 'Review surface contract',
      revision: resolvedReviewRevision({
        kind: 'git-commit',
        id: 'head-sha',
      }),
      repository: {
        repoId: 'repo-1',
        repoFullName: 'example/repo',
        worktreeId: null,
        localPath: '/tmp/repo',
        localAccess: true,
      },
      files: [
        {
          path: 'src/app.ts',
          previousPath: null,
          status: 'modified',
          additions: 1,
          deletions: 1,
          generatedLike: false,
          patchState: 'available',
          patchMessage: null,
        },
      ],
      capabilities: ['comments', 'refresh'],
      externalUrl: 'https://github.com/example/repo/pull/42',
    },
    activePath: 'src/app.ts',
    selection: null,
    selectedAnnotationId: null,
    fileFilter: null,
    reviewOrder: ['src/app.ts'],
    viewMode: 'file',
    presentationMode: 'unified',
    annotationVisibility: ['threads', 'drafts', 'findings'],
  };
}
