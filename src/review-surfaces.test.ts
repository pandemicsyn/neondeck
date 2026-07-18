import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  neonReviewFindingLimits,
  neonReviewFindingSchemaVersion,
  type NeonReviewFindingDraft,
} from '../shared/review-finding';
import {
  reviewSourceSchemaVersion,
  resolvedReviewRevision,
} from '../shared/review-source';
import { createReviewRefreshStatus } from '../shared/review-refresh';
import {
  reviewSurfaceSchemaVersion,
  type ReviewSurfaceChangeEvent,
  type ReviewSurfaceSnapshot,
} from '../shared/review-surface';
import {
  createReviewSurfaceContextPage,
  createDefaultReviewSurfacePromotionTarget,
  reviewSurfaceFindingsApplyAction,
  reviewSurfaceRegistry,
  ReviewSurfaceRegistry,
  ReviewSurfaceFindingPromotionService,
  type ReviewSurfacePromotionTarget,
} from './modules/review-surfaces';
import { runWithFlueExecutionContextForTests } from './modules/flue/execution-context';
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

  it('rejects an invalid finding batch atomically before applying any item', async () => {
    const { app, registry } = harness();
    const events: ReviewSurfaceChangeEvent[] = [];
    registry.subscribe((event) => events.push(event));
    await register(app, snapshot('surface-a'));

    const response = await apply(app, 'surface-a', [
      finding('finding-valid'),
      finding('finding-invalid', { file: 'src/missing.ts' }),
    ]);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      changed: false,
      error: { code: 'file-unavailable' },
    });
    expect(registry.readFindings('surface-a')).toMatchObject({
      ok: true,
      findings: [],
      count: 0,
    });
    expect(events.map((event) => event.action)).toEqual(['registered']);
  });

  it('rejects out-of-bounds ranges atomically while allowing findings to be hidden', async () => {
    const { app, registry } = harness();
    const events: ReviewSurfaceChangeEvent[] = [];
    registry.subscribe((event) => events.push(event));
    await register(app, snapshot('surface-a'));

    const outOfBounds = await apply(app, 'surface-a', [
      finding('finding-valid'),
      finding('finding-range-too-large', {
        anchor: {
          kind: 'line-range',
          side: 'additions',
          startLine: 1,
          endLine: neonReviewFindingLimits.maxLineRangeSpan + 1,
        },
      }),
    ]);
    expect(outOfBounds.status).toBe(400);
    expect(registry.readFindings('surface-a').count).toBe(0);

    registry.upsert({
      ...snapshot('surface-a'),
      annotationVisibility: ['threads', 'drafts'],
    });
    const hidden = await apply(app, 'surface-a', [
      finding('finding-capability'),
    ]);
    expect(hidden.status).toBe(200);
    expect(await hidden.json()).toMatchObject({
      ok: true,
      findings: [{ id: 'finding-capability' }],
    });
    expect(registry.readFindings('surface-a').count).toBe(1);
    expect(
      events.filter((event) => event.action === 'findings-changed'),
    ).toHaveLength(1);
  });

  it('stales active findings on a revision change and rejects the old revision', async () => {
    const { app, registry } = harness();
    const events: ReviewSurfaceChangeEvent[] = [];
    registry.subscribe((event) => events.push(event));
    await register(app, snapshot('surface-a'));
    expect((await apply(app, 'surface-a', [finding('finding-a')])).status).toBe(
      200,
    );

    await register(app, snapshot('surface-a', 'next-head-sha'));

    expect(registry.readFindings('surface-a')).toMatchObject({
      findings: [
        {
          id: 'finding-a',
          revisionKey: 'git-commit::head-sha',
          lifecycle: {
            state: 'stale',
            reason: 'The review surface source or revision changed.',
          },
        },
      ],
    });
    expect(events.at(-1)).toMatchObject({
      action: 'findings-changed',
      surfaceId: 'surface-a',
      findings: {
        action: 'staled',
        revisionKey: 'git-commit::next-head-sha',
        findingIds: ['finding-a'],
        count: 1,
      },
    });
    const staleResponse = await apply(app, 'surface-a', [finding('finding-b')]);
    expect(staleResponse.status).toBe(409);
    await expect(staleResponse.json()).resolves.toMatchObject({
      error: { code: 'stale-revision' },
      revisionKey: 'git-commit::next-head-sha',
    });
    expect(registry.readFindings('surface-a').count).toBe(1);
  });

  it('replaces a non-active stable id after the surface source and revision change', async () => {
    const { app, registry } = harness();
    const events: ReviewSurfaceChangeEvent[] = [];
    registry.subscribe((event) => events.push(event));
    await register(app, snapshot('surface-a'));
    expect((await apply(app, 'surface-a', [finding('finding-a')])).status).toBe(
      200,
    );

    const nextSourceId = 'github-pr:example/other#42';
    const nextRevisionKey = 'git-commit::next-head-sha';
    await register(app, snapshot('surface-a', 'next-head-sha', nextSourceId));
    const response = await apply(
      app,
      'surface-a',
      [
        finding('finding-a', {
          sourceId: nextSourceId,
          revisionKey: nextRevisionKey,
          title: 'Current revision finding',
        }),
      ],
      nextRevisionKey,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      changed: true,
      findingIds: ['finding-a'],
      count: 1,
    });
    expect(registry.readFindings('surface-a')).toMatchObject({
      count: 1,
      findings: [
        {
          id: 'finding-a',
          sourceId: nextSourceId,
          revisionKey: nextRevisionKey,
          title: 'Current revision finding',
          lifecycle: { state: 'active' },
        },
      ],
    });
    expect(events.at(-1)).toMatchObject({
      action: 'findings-changed',
      surfaceId: 'surface-a',
      findings: {
        action: 'applied',
        findingIds: ['finding-a'],
        count: 1,
      },
    });
    expect(
      events.filter((event) => event.findings?.action === 'applied'),
    ).toHaveLength(2);
  });

  it('replaces a dismissed stable id after the surface revision changes', () => {
    const registry = new ReviewSurfaceRegistry();
    registries.push(registry);
    registry.upsert(snapshot('surface-a'));
    registry.applyFindings('surface-a', {
      revisionKey: 'git-commit::head-sha',
      findings: [finding('finding-a')],
    });
    registry.dismissFindings('surface-a', {
      sourceId: 'github-pr:example/repo#42',
      revisionKey: 'git-commit::head-sha',
      findingIds: ['finding-a'],
      reason: 'Dismissed on the prior revision.',
    });
    registry.upsert(snapshot('surface-a', 'next-head-sha'));

    expect(
      registry.applyFindings('surface-a', {
        revisionKey: 'git-commit::next-head-sha',
        findings: [
          finding('finding-a', {
            revisionKey: 'git-commit::next-head-sha',
            title: 'Valid finding on the current revision',
          }),
        ],
      }),
    ).toMatchObject({ ok: true, changed: true, count: 1 });
    expect(registry.readFindings('surface-a')).toMatchObject({
      count: 1,
      findings: [
        {
          id: 'finding-a',
          revisionKey: 'git-commit::next-head-sha',
          title: 'Valid finding on the current revision',
          lifecycle: { state: 'active' },
        },
      ],
    });
  });

  it('isolates findings and targeted events between surfaces for one source', async () => {
    const { app, registry } = harness();
    const events: ReviewSurfaceChangeEvent[] = [];
    registry.subscribe((event) => events.push(event));
    await register(app, snapshot('surface-a'));
    await register(app, snapshot('surface-b'));

    const response = await apply(app, 'surface-a', [finding('finding-a')]);

    expect(response.status).toBe(200);
    expect(registry.readFindings('surface-a').count).toBe(1);
    expect(registry.readFindings('surface-b').count).toBe(0);
    expect(
      events.filter((event) => event.action === 'findings-changed'),
    ).toEqual([
      expect.objectContaining({
        surfaceId: 'surface-a',
        findings: expect.objectContaining({ findingIds: ['finding-a'] }),
      }),
    ]);
  });

  it('cleans up ephemeral findings on expiry and explicit close', () => {
    let now = Date.parse('2026-07-18T00:00:00.000Z');
    const registry = new ReviewSurfaceRegistry({ now: () => now, ttlMs: 100 });
    registries.push(registry);
    registry.upsert(snapshot('surface-expiring'));
    expect(
      registry.applyFindings('surface-expiring', {
        revisionKey: 'git-commit::head-sha',
        findings: [finding('reusable-id')],
      }).ok,
    ).toBe(true);

    now += 101;
    expect(registry.list()).toEqual([]);
    registry.upsert(snapshot('surface-expiring'));
    expect(
      registry.applyFindings('surface-expiring', {
        revisionKey: 'git-commit::head-sha',
        findings: [
          finding('reusable-id', { title: 'Content after expiry cleanup' }),
        ],
      }),
    ).toMatchObject({ ok: true, changed: true, count: 1 });

    registry.upsert(snapshot('surface-closed'));
    registry.applyFindings('surface-closed', {
      revisionKey: 'git-commit::head-sha',
      findings: [finding('closed-id')],
    });
    expect(registry.remove('surface-closed')).toBe(true);
    registry.upsert(snapshot('surface-closed'));
    expect(
      registry.applyFindings('surface-closed', {
        revisionKey: 'git-commit::head-sha',
        findings: [
          finding('closed-id', { title: 'Content after close cleanup' }),
        ],
      }),
    ).toMatchObject({ ok: true, changed: true, count: 1 });
  });

  it('enforces text and batch limits without publishing large event payloads', async () => {
    const { app, registry } = harness();
    const events: ReviewSurfaceChangeEvent[] = [];
    registry.subscribe((event) => events.push(event));
    await register(app, snapshot('surface-a'));
    const oversizedBatch = Array.from(
      { length: neonReviewFindingLimits.maxApplyBatch + 1 },
      (_, index) => finding(`finding-${index}`),
    );

    const batchResponse = await apply(app, 'surface-a', oversizedBatch);
    expect(batchResponse.status).toBe(400);
    const textResponse = await apply(app, 'surface-a', [
      finding('finding-long', {
        title: 'x'.repeat(neonReviewFindingLimits.maxTitleLength + 1),
      }),
    ]);
    expect(textResponse.status).toBe(400);
    expect(registry.readFindings('surface-a').count).toBe(0);

    expect(
      (
        await apply(app, 'surface-a', [
          finding('finding-bounded', {
            explanation: 'private finding explanation',
          }),
        ])
      ).status,
    ).toBe(200);
    const event = events.at(-1)!;
    expect(event).toMatchObject({
      action: 'findings-changed',
      findings: {
        action: 'applied',
        findingIds: ['finding-bounded'],
        count: 1,
      },
    });
    expect(JSON.stringify(event)).not.toContain('private finding explanation');
    expect(event.surface).toBeNull();
  });

  it('server-stamps local API provenance instead of trusting caller fields', async () => {
    const { app, registry } = harness();
    await register(app, snapshot('surface-a'));

    const response = await apply(app, 'surface-a', [
      finding('finding-spoofed', {
        provenance: {
          authorRole: 'untrusted-caller',
          model: 'spoofed-model',
          workflowRunId: 'spoofed-run',
        },
      }),
    ]);

    expect(response.status).toBe(200);
    expect(registry.readFindings('surface-a')).toMatchObject({
      findings: [
        {
          id: 'finding-spoofed',
          provenance: {
            authorRole: 'local-api',
            model: null,
            workflowRunId: null,
          },
        },
      ],
    });
    expect(
      registry.readFindings('surface-a').findings?.[0]?.provenance.createdAt,
    ).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('server-stamps Flue provenance from the current execution context', async () => {
    const surfaceId = 'surface-flue-provenance';
    reviewSurfaceRegistry.remove(surfaceId);
    reviewSurfaceRegistry.upsert(snapshot(surfaceId));
    try {
      const result = await runWithFlueExecutionContextForTests(
        { agentName: 'display-assistant', runId: 'trusted-run' },
        () =>
          reviewSurfaceFindingsApplyAction.run({
            input: {
              surfaceId,
              revisionKey: 'git-commit::head-sha',
              findings: [
                finding('finding-flue-spoofed', {
                  provenance: {
                    authorRole: 'untrusted-caller',
                    model: 'spoofed-model',
                    workflowRunId: 'spoofed-run',
                  },
                }),
              ],
            },
          } as never),
      );

      expect(result).toMatchObject({ ok: true, changed: true });
      expect(reviewSurfaceRegistry.readFindings(surfaceId)).toMatchObject({
        findings: [
          {
            provenance: {
              authorRole: 'display-assistant',
              model: null,
              workflowRunId: 'trusted-run',
            },
          },
        ],
      });
    } finally {
      reviewSurfaceRegistry.remove(surfaceId);
    }
  });

  it('validates the complete trusted finding schema in the service before applying a batch', () => {
    const registry = new ReviewSurfaceRegistry();
    registries.push(registry);
    registry.upsert(snapshot('surface-a'));

    expect(
      registry.applyFindings('surface-a', {
        revisionKey: 'git-commit::head-sha',
        findings: [
          finding('finding-valid'),
          finding('finding-invalid-provenance', {
            provenance: {
              authorRole: '',
              model: null,
              workflowRunId: null,
            },
          }),
        ],
      }),
    ).toMatchObject({
      ok: false,
      changed: false,
      error: { code: 'invalid-finding' },
    });
    expect(registry.readFindings('surface-a').count).toBe(0);
  });

  it('stores canonical parsed finding output for direct trusted calls', () => {
    const registry = new ReviewSurfaceRegistry();
    registries.push(registry);
    registry.upsert(snapshot('surface-a'));
    const input = {
      ...finding('finding-canonical'),
      ignoredTopLevel: 'strip this',
      provenance: {
        ...finding('finding-canonical').provenance,
        ignoredNested: 'strip this too',
      },
    } as NeonReviewFindingDraft;

    expect(
      registry.applyFindings('surface-a', {
        revisionKey: 'git-commit::head-sha',
        findings: [input],
      }),
    ).toMatchObject({ ok: true, changed: true });
    const stored = registry.readFindings('surface-a').findings?.[0];
    expect(stored).not.toHaveProperty('ignoredTopLevel');
    expect(stored?.provenance).not.toHaveProperty('ignoredNested');
  });

  it('pages model-facing context with bounded windows and totals', () => {
    const registry = new ReviewSurfaceRegistry();
    registries.push(registry);
    const base = snapshot('surface-a');
    const files = Array.from({ length: 60 }, (_, index) => ({
      ...base.source.files[0]!,
      path: `src/file-${index}.ts`,
    }));
    const surface = registry.upsert({
      ...base,
      source: { ...base.source, files },
      activePath: files[0]!.path,
      reviewOrder: files.map((file) => file.path),
    });
    const findings = Array.from({ length: 55 }, (_, index) =>
      finding(`finding-${index}`, { file: files[index]!.path }),
    );
    registry.applyFindings('surface-a', {
      revisionKey: 'git-commit::head-sha',
      findings: findings.slice(0, 50),
    });
    registry.applyFindings('surface-a', {
      revisionKey: 'git-commit::head-sha',
      findings: findings.slice(50),
    });
    const stored = registry.readFindings('surface-a').findings ?? [];

    const defaultPage = createReviewSurfaceContextPage(surface, stored);
    expect(defaultPage.summary.counts).toEqual({
      files: 60,
      reviewOrder: 60,
      findings: 55,
    });
    expect(defaultPage.summary.source).not.toHaveProperty('files');
    expect(defaultPage.summary).not.toHaveProperty('reviewOrder');
    expect(defaultPage.page.files).toMatchObject({
      offset: 0,
      limit: 25,
      total: 60,
      nextOffset: 25,
    });
    expect(defaultPage.page.files.items).toHaveLength(25);
    expect(defaultPage.page.reviewOrder.items).toHaveLength(25);
    expect(defaultPage.page.findings.items).toHaveLength(25);

    const maximumPage = createReviewSurfaceContextPage(surface, stored, {
      limit: 500,
    });
    expect(maximumPage.page.files).toMatchObject({
      limit: 50,
      total: 60,
      nextOffset: 50,
    });
    expect(maximumPage.page.files.items).toHaveLength(50);
    expect(maximumPage.page.reviewOrder.items).toHaveLength(50);
    expect(maximumPage.page.findings.items).toHaveLength(50);
  });

  it('rejects delayed dismiss and clear requests after the mounted revision changes', () => {
    const registry = new ReviewSurfaceRegistry();
    registries.push(registry);
    registry.upsert(snapshot('surface-a'));
    registry.applyFindings('surface-a', {
      revisionKey: 'git-commit::head-sha',
      findings: [finding('finding-a')],
    });
    const delayedDismiss = {
      sourceId: 'github-pr:example/repo#42',
      revisionKey: 'git-commit::head-sha',
      findingIds: ['finding-a'],
      reason: 'Delayed dismissal.',
    };
    const delayedClear = {
      sourceId: 'github-pr:example/repo#42',
      revisionKey: 'git-commit::head-sha',
    };

    registry.upsert(snapshot('surface-a', 'next-head-sha'));
    registry.applyFindings('surface-a', {
      revisionKey: 'git-commit::next-head-sha',
      findings: [
        finding('finding-a', {
          revisionKey: 'git-commit::next-head-sha',
          title: 'Current revision content',
        }),
      ],
    });

    expect(registry.dismissFindings('surface-a', delayedDismiss)).toMatchObject(
      {
        ok: false,
        changed: false,
        error: { code: 'stale-revision' },
      },
    );
    expect(registry.clearFindings('surface-a', delayedClear)).toMatchObject({
      ok: false,
      changed: false,
      error: { code: 'stale-revision' },
    });
    expect(
      registry.clearFindings('surface-a', {
        sourceId: 'github-pr:example/other#42',
        revisionKey: 'git-commit::next-head-sha',
      }),
    ).toMatchObject({
      ok: false,
      changed: false,
      error: { code: 'source-mismatch' },
    });
    expect(registry.readFindings('surface-a')).toMatchObject({
      count: 1,
      findings: [
        {
          id: 'finding-a',
          revisionKey: 'git-commit::next-head-sha',
          title: 'Current revision content',
          lifecycle: { state: 'active' },
        },
      ],
    });
  });

  it('allows a current-revision command to dismiss a stale finding', () => {
    const registry = new ReviewSurfaceRegistry();
    registries.push(registry);
    registry.upsert(snapshot('surface-a'));
    registry.applyFindings('surface-a', {
      revisionKey: 'git-commit::head-sha',
      findings: [finding('finding-a')],
    });
    registry.upsert(snapshot('surface-a', 'next-head-sha'));

    expect(
      registry.dismissFindings('surface-a', {
        sourceId: 'github-pr:example/repo#42',
        revisionKey: 'git-commit::next-head-sha',
        findingIds: ['finding-a'],
        reason: 'Acknowledged stale finding.',
      }),
    ).toMatchObject({ ok: true, changed: true, findingIds: ['finding-a'] });
    expect(registry.readFindings('surface-a')).toMatchObject({
      findings: [{ lifecycle: { state: 'dismissed' } }],
    });
  });

  it('caps per-surface retention and bounds bulk-change event ids', () => {
    const registry = new ReviewSurfaceRegistry();
    registries.push(registry);
    const events: ReviewSurfaceChangeEvent[] = [];
    registry.subscribe((event) => events.push(event));
    registry.upsert(snapshot('surface-a'));

    const batchCount =
      neonReviewFindingLimits.maxFindingsPerSurface /
      neonReviewFindingLimits.maxApplyBatch;
    for (let batch = 0; batch < batchCount; batch += 1) {
      const findings = Array.from(
        { length: neonReviewFindingLimits.maxApplyBatch },
        (_, index) => finding(`finding-${batch}-${index}`),
      );
      expect(
        registry.applyFindings('surface-a', {
          revisionKey: 'git-commit::head-sha',
          findings,
        }),
      ).toMatchObject({
        ok: true,
        changed: true,
        count: neonReviewFindingLimits.maxApplyBatch,
      });
    }
    expect(registry.readFindings('surface-a').count).toBe(
      neonReviewFindingLimits.maxFindingsPerSurface,
    );
    expect(
      registry.applyFindings('surface-a', {
        revisionKey: 'git-commit::head-sha',
        findings: [finding('finding-overflow')],
      }),
    ).toMatchObject({
      ok: false,
      changed: false,
      error: { code: 'surface-finding-limit' },
    });
    expect(registry.readFindings('surface-a').count).toBe(
      neonReviewFindingLimits.maxFindingsPerSurface,
    );

    registry.upsert(snapshot('surface-a', 'next-head-sha'));
    expect(
      registry.applyFindings('surface-a', {
        revisionKey: 'git-commit::next-head-sha',
        findings: [
          finding('finding-0-0', {
            revisionKey: 'git-commit::next-head-sha',
            title: 'Replacement at the surface cap',
          }),
        ],
      }),
    ).toMatchObject({ ok: true, changed: true, count: 1 });
    expect(registry.readFindings('surface-a').count).toBe(
      neonReviewFindingLimits.maxFindingsPerSurface,
    );
    expect(
      registry.applyFindings('surface-a', {
        revisionKey: 'git-commit::next-head-sha',
        findings: [
          finding('finding-current-overflow', {
            revisionKey: 'git-commit::next-head-sha',
          }),
        ],
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'surface-finding-limit' },
    });

    expect(
      registry.clearFindings('surface-a', {
        sourceId: 'github-pr:example/repo#42',
        revisionKey: 'git-commit::next-head-sha',
      }),
    ).toMatchObject({
      ok: true,
      changed: true,
      count: neonReviewFindingLimits.maxFindingsPerSurface,
    });
    expect(events.at(-1)).toMatchObject({
      action: 'findings-changed',
      findings: {
        action: 'cleared',
        count: neonReviewFindingLimits.maxFindingsPerSurface,
      },
    });
    expect(events.at(-1)?.findings?.findingIds).toHaveLength(
      neonReviewFindingLimits.maxEventFindingIds,
    );
  });

  it('keeps identical applies idempotent and rejects same-revision conflicts atomically', async () => {
    const { app, registry } = harness();
    const events: ReviewSurfaceChangeEvent[] = [];
    registry.subscribe((event) => events.push(event));
    await register(app, snapshot('surface-a'));

    const first = await apply(app, 'surface-a', [finding('finding-a')]);
    const second = await apply(app, 'surface-a', [finding('finding-a')]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      ok: true,
      changed: false,
      count: 0,
    });
    const conflictingBatch = await apply(app, 'surface-a', [
      finding('finding-b'),
      finding('finding-a', { title: 'Conflicting stable id content' }),
    ]);
    expect(conflictingBatch.status).toBe(409);
    await expect(conflictingBatch.json()).resolves.toMatchObject({
      changed: false,
      error: { code: 'finding-id-conflict' },
    });
    expect(registry.readFindings('surface-a').count).toBe(1);
    expect(
      events.filter((event) => event.action === 'findings-changed'),
    ).toHaveLength(1);

    const dismissBody = JSON.stringify({
      sourceId: 'github-pr:example/repo#42',
      revisionKey: 'git-commit::head-sha',
      findingIds: ['finding-a'],
      reason: 'Not actionable.',
    });
    const dismiss = () =>
      app.request(
        'http://localhost/api/review-surfaces/surface-a/findings/dismiss',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: dismissBody,
        },
      );
    expect((await dismiss()).status).toBe(200);
    const duplicateDismiss = await dismiss();
    await expect(duplicateDismiss.json()).resolves.toMatchObject({
      changed: false,
      count: 0,
    });
    expect(
      events.filter((event) => event.action === 'findings-changed'),
    ).toHaveLength(2);
    expect(registry.readFindings('surface-a')).toMatchObject({
      findings: [{ lifecycle: { state: 'dismissed' } }],
    });

    const clear = () =>
      app.request(
        'http://localhost/api/review-surfaces/surface-a/findings/clear',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sourceId: 'github-pr:example/repo#42',
            revisionKey: 'git-commit::head-sha',
            findingIds: ['finding-a'],
          }),
        },
      );
    expect((await clear()).status).toBe(200);
    const duplicateClear = await clear();
    await expect(duplicateClear.json()).resolves.toMatchObject({
      changed: false,
      count: 0,
    });
    expect(registry.readFindings('surface-a').count).toBe(0);
    expect(
      events.filter((event) => event.action === 'findings-changed'),
    ).toHaveLength(3);
  });

  it('promotes a current GitHub finding once and publishes only to its surface', async () => {
    const promoteTarget = vi.fn<ReviewSurfacePromotionTarget>(async () => ({
      ok: true,
      promotion: {
        destination: 'github-review-draft',
        targetId: 'comment-1',
        containerId: 'draft-1',
      },
    }));
    const { app, registry } = harness(promoteTarget);
    const events: ReviewSurfaceChangeEvent[] = [];
    registry.subscribe((event) => events.push(event));
    await register(app, snapshot('surface-a'));
    await register(app, snapshot('surface-b'));
    await apply(app, 'surface-a', [finding('finding-a')]);
    const request = promotionRequest('finding-a', 'request-1');

    const response = await promote(app, 'surface-a', request);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      changed: true,
      findings: [
        {
          id: 'finding-a',
          lifecycle: {
            state: 'promoted',
            promotion: {
              destination: 'github-review-draft',
              requestId: 'request-1',
              targetId: 'comment-1',
              containerId: 'draft-1',
            },
          },
        },
      ],
    });
    expect(promoteTarget).toHaveBeenCalledTimes(1);
    expect(promoteTarget.mock.calls[0]?.[0]).toMatchObject({
      finding: {
        file: 'src/app.ts',
        anchor: {
          kind: 'line-range',
          side: 'additions',
          startLine: 10,
          endLine: 11,
        },
      },
      request: {
        destination: 'github-review-draft',
        anchor: { side: 'additions', startLine: 10, endLine: 11 },
      },
    });
    expect(registry.readFindings('surface-b').count).toBe(0);
    expect(
      events.filter((event) => event.findings?.action === 'promoted'),
    ).toEqual([
      expect.objectContaining({
        surfaceId: 'surface-a',
        findings: expect.objectContaining({ findingIds: ['finding-a'] }),
      }),
    ]);

    const retry = await promote(app, 'surface-a', request);
    expect(retry.status).toBe(200);
    expect(promoteTarget).toHaveBeenCalledTimes(1);
    const conflictingRetry = await promote(app, 'surface-a', {
      ...request,
      anchor: { side: 'additions', startLine: 10, endLine: 10 },
    });
    expect(conflictingRetry.status).toBe(409);
    await expect(conflictingRetry.json()).resolves.toMatchObject({
      error: { code: 'promotion-request-conflict' },
    });
    expect(promoteTarget).toHaveBeenCalledTimes(1);
    const secondActivation = await promote(
      app,
      'surface-a',
      promotionRequest('finding-a', 'request-2'),
    );
    expect(secondActivation.status).toBe(409);
    await expect(secondActivation.json()).resolves.toMatchObject({
      error: { code: 'already-promoted' },
    });
  });

  it('replays an exact retained promotion after completed-cache eviction and rejects altered input', async () => {
    const promoteTarget = vi.fn<ReviewSurfacePromotionTarget>(
      async (candidate) => ({
        ok: true,
        promotion: {
          destination: 'github-review-draft',
          targetId: `comment-${candidate.finding.id}`,
          containerId: 'draft-shared',
        },
      }),
    );
    const { promotionService, registry } = harness(promoteTarget);
    const firstRequest = promotionRequest('finding-0', 'request-0');
    for (let index = 0; index <= 400; index += 1) {
      const surfaceId = `surface-cache-${index}`;
      const findingId = `finding-${index}`;
      registry.upsert(snapshot(surfaceId));
      registry.applyFindings(surfaceId, {
        revisionKey: 'git-commit::head-sha',
        findings: [finding(findingId)],
      });
      await expect(
        promotionService.promote(
          surfaceId,
          promotionRequest(findingId, `request-${index}`),
        ),
      ).resolves.toMatchObject({ ok: true, changed: true });
    }
    registry.applyFindings('surface-cache-0', {
      revisionKey: 'git-commit::head-sha',
      findings: [finding('finding-0-active')],
    });

    await expect(
      promotionService.promote('surface-cache-0', {
        ...firstRequest,
        findingId: 'finding-0-active',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'promotion-request-conflict' },
    });
    expect(promoteTarget).toHaveBeenCalledTimes(401);

    await expect(
      promotionService.promote('surface-cache-0', firstRequest),
    ).resolves.toMatchObject({
      ok: true,
      changed: false,
      findings: [
        {
          lifecycle: {
            promotion: {
              requestId: 'request-0',
              requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
            },
          },
        },
      ],
    });
    expect(promoteTarget).toHaveBeenCalledTimes(401);
    await expect(
      promotionService.promote('surface-cache-0', {
        ...firstRequest,
        reason: 'Altered input using the retained request id.',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'promotion-request-conflict' },
    });
    expect(promoteTarget).toHaveBeenCalledTimes(401);
  });

  it('promotes a valid finding id containing a lone surrogate through the body-only route', async () => {
    const findingId = '\ud800';
    const promoteTarget = vi.fn<ReviewSurfacePromotionTarget>(async () => ({
      ok: true,
      promotion: {
        destination: 'github-review-draft',
        targetId: 'comment-surrogate',
        containerId: 'draft-surrogate',
      },
    }));
    const { app } = harness(promoteTarget);
    await register(app, snapshot('surface-surrogate'));
    await apply(app, 'surface-surrogate', [finding(findingId)]);

    const response = await promote(
      app,
      'surface-surrogate',
      promotionRequest(findingId, 'request-surrogate'),
    );

    expect(response.status).toBe(200);
    expect(promoteTarget).toHaveBeenCalledTimes(1);
  });

  it('rejects mismatched or unbounded destination metadata without changing lifecycle', async () => {
    const promoteTarget = vi.fn<ReviewSurfacePromotionTarget>(async () => ({
      ok: true,
      promotion: {
        destination: 'prepared-diff-revision',
        targetId: 'x'.repeat(
          neonReviewFindingLimits.maxPromotionTargetIdLength + 1,
        ),
        containerId: 'prepared-1',
      },
    }));
    const { app, registry } = harness(promoteTarget);
    await register(app, snapshot('surface-metadata'));
    await apply(app, 'surface-metadata', [finding('finding-metadata')]);

    const response = await promote(
      app,
      'surface-metadata',
      promotionRequest('finding-metadata', 'invalid-metadata'),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'promotion-target-failed' },
    });
    expect(
      registry.readFindings('surface-metadata').findings?.[0]?.lifecycle.state,
    ).toBe('active');
  });

  it('rejects stale, mismatched, unsupported, unavailable-anchor, and unconfirmed promotions before target mutation', async () => {
    const promoteTarget = vi.fn<ReviewSurfacePromotionTarget>();
    const { app, registry } = harness(promoteTarget);
    await register(app, snapshot('surface-a'));
    await apply(app, 'surface-a', [finding('finding-a')]);

    const wrongSource = await promote(app, 'surface-a', {
      ...promotionRequest('finding-a', 'wrong-source'),
      sourceId: 'github-pr:example/other#42',
    });
    expect(wrongSource.status).toBe(409);
    const wrongRevision = await promote(app, 'surface-a', {
      ...promotionRequest('finding-a', 'wrong-revision'),
      revisionKey: 'git-commit::other',
    });
    expect(wrongRevision.status).toBe(409);
    const wrongAnchor = await promote(app, 'surface-a', {
      ...promotionRequest('finding-a', 'wrong-anchor'),
      anchor: { side: 'additions', startLine: 10, endLine: 10 },
    });
    expect(wrongAnchor.status).toBe(409);
    await register(app, snapshot('surface-b'));
    const wrongSurface = await promote(
      app,
      'surface-b',
      promotionRequest('finding-a', 'wrong-surface'),
    );
    expect(wrongSurface.status).toBe(409);
    await expect(wrongSurface.json()).resolves.toMatchObject({
      error: { code: 'finding-unavailable' },
    });

    await register(app, snapshot('surface-stale'));
    await apply(app, 'surface-stale', [finding('stale-finding')]);
    registry.upsert(snapshot('surface-stale', 'new-head'));
    const stale = await promote(
      app,
      'surface-stale',
      promotionRequest('stale-finding', 'stale'),
    );
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      error: { code: 'stale-revision' },
    });

    registry.upsert({
      ...snapshot('surface-a'),
      source: {
        ...snapshot('surface-a').source,
        capabilities: [],
        promotionTargets: [],
      },
    });
    const capabilityMismatch = await promote(
      app,
      'surface-a',
      promotionRequest('finding-a', 'capability'),
    );
    expect(capabilityMismatch.status).toBe(409);
    await expect(capabilityMismatch.json()).resolves.toMatchObject({
      error: { code: 'capability-mismatch' },
    });

    const unsupported = {
      ...snapshot('surface-unsupported'),
      source: {
        ...snapshot('surface-unsupported').source,
        id: 'repo-edit-event:event-1',
        kind: 'repo-edit-event' as const,
      },
    };
    await register(app, unsupported);
    await apply(app, 'surface-unsupported', [
      finding('unsupported-finding', { sourceId: unsupported.source.id }),
    ]);
    const unsupportedResponse = await promote(app, 'surface-unsupported', {
      ...promotionRequest('unsupported-finding', 'unsupported'),
      sourceId: unsupported.source.id,
    });
    expect(unsupportedResponse.status).toBe(409);
    await expect(unsupportedResponse.json()).resolves.toMatchObject({
      error: { code: 'unsupported-source' },
      message: expect.stringContaining('local-only'),
    });
    expect(promoteTarget).not.toHaveBeenCalled();

    const prepared = preparedSnapshot('surface-prepared');
    await register(app, prepared);
    await apply(
      app,
      'surface-prepared',
      [
        finding('prepared-finding', {
          sourceId: prepared.source.id,
          revisionKey: 'worktree-diff::diff-fingerprint',
        }),
      ],
      'worktree-diff::diff-fingerprint',
    );
    const unconfirmed = await promote(app, 'surface-prepared', {
      ...promotionRequest('prepared-finding', 'unconfirmed'),
      sourceId: prepared.source.id,
      revisionKey: 'worktree-diff::diff-fingerprint',
      destination: 'prepared-diff-revision',
      confirm: false,
    });
    expect(unconfirmed.status).toBe(409);
    await expect(unconfirmed.json()).resolves.toMatchObject({
      error: { code: 'confirmation-required' },
    });
    expect(promoteTarget).not.toHaveBeenCalled();
  });

  it('keeps target failures retryable and does not regress a newer revision after a delayed target response', async () => {
    let attempt = 0;
    const retryTarget = vi.fn<ReviewSurfacePromotionTarget>(async () => {
      attempt += 1;
      return attempt === 1
        ? { ok: false, message: 'Temporary target failure.' }
        : {
            ok: true,
            promotion: {
              destination: 'github-review-draft',
              targetId: 'comment-retry',
              containerId: 'draft-retry',
            },
          };
    });
    const retryHarness = harness(retryTarget);
    await register(retryHarness.app, snapshot('surface-retry'));
    await apply(retryHarness.app, 'surface-retry', [finding('retry-finding')]);
    const request = promotionRequest('retry-finding', 'retry-request');
    const failed = await promote(retryHarness.app, 'surface-retry', request);
    expect(failed.status).toBe(409);
    expect(
      retryHarness.registry.readFindings('surface-retry').findings?.[0]
        ?.lifecycle.state,
    ).toBe('active');
    const retried = await promote(retryHarness.app, 'surface-retry', request);
    expect(retried.status).toBe(200);
    expect(retryTarget).toHaveBeenCalledTimes(2);

    const target =
      deferred<Awaited<ReturnType<ReviewSurfacePromotionTarget>>>();
    const delayedTarget = vi.fn<ReviewSurfacePromotionTarget>(
      () => target.promise,
    );
    const delayedHarness = harness(delayedTarget);
    await register(delayedHarness.app, snapshot('surface-delayed'));
    await apply(delayedHarness.app, 'surface-delayed', [finding('delayed')]);
    await register(delayedHarness.app, snapshot('surface-delayed-sibling'));
    await apply(delayedHarness.app, 'surface-delayed-sibling', [
      finding('delayed'),
    ]);
    const delayedResponse = promote(
      delayedHarness.app,
      'surface-delayed',
      promotionRequest('delayed', 'delayed-request'),
    );
    await vi.waitFor(() => expect(delayedTarget).toHaveBeenCalledTimes(1));
    const dismissal = await delayedHarness.app.request(
      'http://localhost/api/review-surfaces/surface-delayed-sibling/findings/dismiss',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sourceId: 'github-pr:example/repo#42',
          revisionKey: 'git-commit::head-sha',
          findingIds: ['delayed'],
          reason: 'Dismiss while promotion is delayed.',
        }),
      },
    );
    expect(dismissal.status).toBe(409);
    await expect(dismissal.json()).resolves.toMatchObject({
      error: { code: 'promotion-pending' },
    });
    expect(
      delayedHarness.registry.readFindings('surface-delayed-sibling')
        .findings?.[0]?.lifecycle.state,
    ).toBe('active');
    delayedHarness.registry.upsert(snapshot('surface-delayed', 'new-head'));
    target.resolve({
      ok: true,
      promotion: {
        destination: 'github-review-draft',
        targetId: 'comment-delayed',
        containerId: 'draft-delayed',
      },
    });
    expect((await delayedResponse).status).toBe(200);
    expect(
      delayedHarness.registry.readFindings('surface-delayed').findings?.[0],
    ).toMatchObject({
      lifecycle: {
        state: 'stale',
        promotion: {
          destination: 'github-review-draft',
          targetId: 'comment-delayed',
        },
      },
    });
  });

  it('seeds only the existing local GitHub draft path with the validated range and provenance', async () => {
    const registry = new ReviewSurfaceRegistry();
    registries.push(registry);
    registry.upsert(snapshot('surface-target'));
    registry.applyFindings('surface-target', {
      revisionKey: 'git-commit::head-sha',
      findings: [
        finding('finding-range', {
          suggestedAction: 'Keep the guard close to the read.',
        }),
        finding('finding-single', {
          anchor: {
            kind: 'line-range',
            side: 'additions',
            startLine: 10,
            endLine: 10,
          },
        }),
        finding('finding-unanchorable', {
          anchor: {
            kind: 'line-range',
            side: 'additions',
            startLine: 20,
            endLine: 20,
          },
        }),
      ],
    });
    const request = promotionRequest('finding-range', 'target-request');
    const validated = registry.validateFindingPromotion(
      'surface-target',
      request,
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error(validated.result.message);

    const putDraft = vi.fn<(...args: unknown[]) => Promise<unknown>>(
      async () => ({
        ok: true,
        action: 'github_pr_review_draft_put',
        changed: true,
        message: 'saved',
        data: {
          draft: { id: 'draft-1', headSha: 'head-sha', comments: [] },
        },
      }),
    );
    const postComment = vi.fn<
      (
        target: unknown,
        input: Record<string, unknown>,
        paths: unknown,
        dependencies: unknown,
        metadata: unknown,
      ) => Promise<unknown>
    >(async (_target, input, _paths, _dependencies, _metadata) => ({
      ok: true,
      action: 'github_pr_review_draft_comment_post',
      changed: true,
      message: 'saved comment',
      data: {
        draft: {
          id: 'draft-1',
          comments: [
            {
              id: 'comment-1',
              sourceFindingId: input.sourceFindingId,
            },
          ],
        },
      },
    }));
    const target = createDefaultReviewSurfacePromotionTarget(undefined, {
      readGitHubFileDiff: (async () => ({
        ok: true,
        action: 'github_pr_file_diff_get',
        changed: false,
        message: 'read patch',
        data: { diff: promotionPatch() },
      })) as never,
      getGitHubDraft: (async () => ({
        ok: true,
        action: 'github_pr_review_draft_get',
        changed: false,
        message: 'no draft',
        data: { draft: null },
      })) as never,
      putGitHubDraft: putDraft as never,
      postGitHubDraftComment: postComment as never,
    });
    const result = await target(validated.value);

    expect(result).toMatchObject({
      ok: true,
      promotion: {
        destination: 'github-review-draft',
        targetId: 'comment-1',
        containerId: 'draft-1',
      },
    });
    expect(putDraft).toHaveBeenCalledWith(
      { repo: 'example/repo', prNumber: 42 },
      { headSha: 'head-sha' },
      expect.any(Object),
    );
    expect(postComment.mock.calls[0]?.[1]).toMatchObject({
      draftId: 'draft-1',
      path: 'src/app.ts',
      side: 'RIGHT',
      line: 11,
      startLine: 10,
      startSide: 'RIGHT',
      body: expect.stringContaining('Keep the guard close to the read.'),
      sourceFindingId: expect.stringMatching(/^neon_surface_[a-f0-9]{32}$/),
    });
    expect(postComment.mock.calls[0]?.[1].body).toContain(
      'role display-assistant; model openai/gpt-5.6; run run-1',
    );
    expect(postComment.mock.calls[0]?.[4]).toEqual({ origin: 'neon' });

    const singleRequest = {
      ...promotionRequest('finding-single', 'single-request'),
      anchor: { side: 'additions' as const, startLine: 10, endLine: 10 },
    };
    const single = registry.validateFindingPromotion(
      'surface-target',
      singleRequest,
    );
    expect(single.ok).toBe(true);
    if (!single.ok) throw new Error(single.result.message);
    await expect(target(single.value)).resolves.toMatchObject({ ok: true });
    expect(postComment.mock.calls[1]?.[1]).toMatchObject({
      line: 10,
      startLine: null,
      startSide: null,
    });

    const unanchorableRequest = {
      ...promotionRequest('finding-unanchorable', 'unanchorable-request'),
      anchor: { side: 'additions' as const, startLine: 20, endLine: 20 },
    };
    const unanchorable = registry.validateFindingPromotion(
      'surface-target',
      unanchorableRequest,
    );
    expect(unanchorable.ok).toBe(true);
    if (!unanchorable.ok) throw new Error(unanchorable.result.message);
    await expect(target(unanchorable.value)).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('anchor is unavailable'),
    });
    expect(putDraft).toHaveBeenCalledTimes(2);
    expect(postComment).toHaveBeenCalledTimes(2);
  });

  it('rejects an existing stale GitHub draft even when the anchor line still exists on the new head', async () => {
    const registry = new ReviewSurfaceRegistry();
    registries.push(registry);
    registry.upsert(snapshot('surface-stale-draft'));
    registry.applyFindings('surface-stale-draft', {
      revisionKey: 'git-commit::head-sha',
      findings: [finding('finding-same-line')],
    });
    const validated = registry.validateFindingPromotion(
      'surface-stale-draft',
      promotionRequest('finding-same-line', 'stale-draft-request'),
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error(validated.result.message);
    const putDraft = vi.fn<(...args: unknown[]) => Promise<unknown>>();
    const postComment = vi.fn<(...args: unknown[]) => Promise<unknown>>();
    const target = createDefaultReviewSurfacePromotionTarget(undefined, {
      readGitHubFileDiff: (async () => ({
        ok: true,
        action: 'github_pr_file_diff_get',
        changed: false,
        message: 'current patch still has the same line',
        data: { diff: promotionPatch() },
      })) as never,
      getGitHubDraft: (async () => ({
        ok: true,
        action: 'github_pr_review_draft_get',
        changed: false,
        message: 'old draft',
        data: {
          draft: {
            id: 'draft-old',
            headSha: 'previous-head-sha',
            comments: [],
          },
        },
      })) as never,
      putGitHubDraft: putDraft as never,
      postGitHubDraftComment: postComment as never,
    });

    await expect(target(validated.value)).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('Refresh and re-anchor'),
    });
    expect(putDraft).not.toHaveBeenCalled();
    expect(postComment).not.toHaveBeenCalled();
  });

  it('routes prepared promotion through the existing revision request service without running a revision', async () => {
    const registry = new ReviewSurfaceRegistry();
    registries.push(registry);
    const prepared = preparedSnapshot('surface-prepared-target');
    registry.upsert(prepared);
    registry.applyFindings('surface-prepared-target', {
      revisionKey: 'worktree-diff::diff-fingerprint',
      findings: [
        finding('prepared-finding', {
          sourceId: prepared.source.id,
          revisionKey: 'worktree-diff::diff-fingerprint',
          suggestedAction: 'Add a focused regression test.',
        }),
      ],
    });
    const request = {
      ...promotionRequest('prepared-finding', 'prepared-target-request'),
      sourceId: prepared.source.id,
      revisionKey: 'worktree-diff::diff-fingerprint',
      destination: 'prepared-diff-revision' as const,
      confirm: true,
      reason: 'Please revise this guard and keep the regression test focused.',
    };
    const validated = registry.validateFindingPromotion(
      'surface-prepared-target',
      request,
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error(validated.result.message);
    const requestRevision = vi.fn<
      (input: Record<string, unknown>) => Promise<unknown>
    >(async (_input) => ({
      ok: true,
      action: 'prepared_diff_request_revision',
      changed: true,
      message: 'recorded',
      preparedDiff: { id: 'prepared-1' },
      approvals: [{ id: 'revision-approval', approvalType: 'revision' }],
    }));
    const target = createDefaultReviewSurfacePromotionTarget(undefined, {
      readPreparedFileDiff: (async () => ({
        ok: true,
        action: 'prepared_diff_file_diff',
        changed: false,
        message: 'read patch',
        diff: promotionPatch(),
      })) as never,
      requestPreparedRevision: requestRevision as never,
    });

    await expect(target(validated.value)).resolves.toMatchObject({
      ok: true,
      promotion: {
        destination: 'prepared-diff-revision',
        targetId: 'revision-approval',
        containerId: 'prepared-1',
      },
    });
    expect(requestRevision).toHaveBeenCalledTimes(1);
    expect(requestRevision.mock.calls[0]?.[0]).toMatchObject({
      preparedDiffId: 'prepared-1',
      approverSurface: 'surface-prepared-target',
      reason: expect.stringContaining('Source Neon finding'),
      findingPromotion: {
        surfaceId: 'surface-prepared-target',
        sourceId: 'prepared-diff:prepared-1',
        revisionKey: 'worktree-diff::diff-fingerprint',
        findingId: 'prepared-finding',
        sourceFindingId: expect.stringMatching(/^neon_surface_[a-f0-9]{32}$/),
      },
    });
  });
});

function harness(promoteTarget?: ReviewSurfacePromotionTarget) {
  const registry = new ReviewSurfaceRegistry();
  registries.push(registry);
  const promotionService = new ReviewSurfaceFindingPromotionService(
    registry,
    promoteTarget,
  );
  return {
    app: new Hono().route(
      '/api',
      createReviewSurfaceRoutes(registry, promotionService),
    ),
    promotionService,
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

function snapshot(
  surfaceId: string,
  revisionId = 'head-sha',
  sourceId = 'github-pr:example/repo#42',
): ReviewSurfaceSnapshot {
  return {
    schemaVersion: reviewSurfaceSchemaVersion,
    surfaceId,
    source: {
      schemaVersion: reviewSourceSchemaVersion,
      id: sourceId,
      kind: 'github-pr',
      title: 'Review surface contract',
      revision: resolvedReviewRevision({
        kind: 'git-commit',
        id: revisionId,
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
      promotionTargets: [
        {
          destination: 'github-review-draft',
          repoFullName: 'example/repo',
          prNumber: 42,
        },
      ],
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
    refresh: createReviewRefreshStatus({
      appliedRevision: resolvedReviewRevision({
        kind: 'git-commit',
        id: revisionId,
      }),
    }),
  };
}

function finding(
  id: string,
  overrides: Partial<NeonReviewFindingDraft> = {},
): NeonReviewFindingDraft {
  return {
    schemaVersion: neonReviewFindingSchemaVersion,
    id,
    sourceId: 'github-pr:example/repo#42',
    revisionKey: 'git-commit::head-sha',
    file: 'src/app.ts',
    anchor: {
      kind: 'line-range',
      side: 'additions',
      startLine: 10,
      endLine: 11,
    },
    title: 'Check this behavior',
    explanation: 'The behavior may not match the intended contract.',
    severity: 'major',
    confidence: 'high',
    suggestedAction: null,
    provenance: {
      authorRole: 'display-assistant',
      model: 'openai/gpt-5.6',
      workflowRunId: 'run-1',
    },
    ...overrides,
  };
}

function promotionRequest(findingId: string, requestId: string) {
  return {
    sourceId: 'github-pr:example/repo#42',
    revisionKey: 'git-commit::head-sha',
    findingId,
    requestId,
    destination: 'github-review-draft' as const,
    anchor: { side: 'additions' as const, startLine: 10, endLine: 11 },
    confirm: false,
    reason: null,
  };
}

function preparedSnapshot(surfaceId: string): ReviewSurfaceSnapshot {
  const base = snapshot(surfaceId);
  return {
    ...base,
    source: {
      ...base.source,
      id: 'prepared-diff:prepared-1',
      kind: 'prepared-diff',
      revision: resolvedReviewRevision({
        kind: 'worktree-diff',
        id: 'diff-fingerprint',
      }),
      capabilities: ['request-revision', 'refresh'],
      promotionTargets: [
        {
          destination: 'prepared-diff-revision',
          preparedDiffId: 'prepared-1',
        },
      ],
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function promotionPatch() {
  return [
    'diff --git a/src/app.ts b/src/app.ts',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -9,3 +9,3 @@',
    ' context',
    '-old value',
    '+new value',
    ' tail',
    '',
  ].join('\n');
}

function apply(
  app: Hono,
  surfaceId: string,
  findings: NeonReviewFindingDraft[],
  revisionKey = 'git-commit::head-sha',
) {
  return app.request(
    `http://localhost/api/review-surfaces/${surfaceId}/findings/apply`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        revisionKey,
        findings,
      }),
    },
  );
}

function promote(
  app: Hono,
  surfaceId: string,
  request: ReturnType<typeof promotionRequest> | Record<string, unknown>,
) {
  return app.request(
    `http://localhost/api/review-surfaces/${surfaceId}/findings/promote`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    },
  );
}
