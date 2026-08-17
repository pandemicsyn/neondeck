import type { FlueObservation } from '@flue/runtime';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
  formatApiRequest,
  formatFlueActivity,
  logApiRequests,
  type ServerLogLevel,
} from './request-logging';

type LogWriter = (level: ServerLogLevel, message: string) => void;

describe('API request logging', () => {
  it('logs sanitized action diagnostics from failed JSON responses', async () => {
    const write = vi.fn<LogWriter>();
    const now = vi
      .fn<() => number>()
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(118);
    const app = new Hono();
    app.use('/api/*', logApiRequests({ now, write }));
    app.post('/api/reviews', (context) =>
      context.json(
        {
          ok: false,
          action: 'pr_review_start',
          message: 'Could not fetch GitHub PR event state.',
          errors: [
            'GitHub request failed with 403: Resource not accessible by integration',
          ],
          token: 'must-not-be-logged',
        },
        400,
      ),
    );

    const response = await app.request('/api/reviews', { method: 'POST' });

    expect(response.status).toBe(400);
    expect(write).toHaveBeenCalledWith(
      'warn',
      [
        '[neondeck] HTTP POST /api/reviews 400 18ms',
        '  action    pr_review_start',
        '  message   Could not fetch GitHub PR event state.',
        '  error     GitHub request failed with 403: Resource not accessible by integration',
      ].join('\n'),
    );
    expect(write.mock.calls[0]?.[1]).not.toContain('must-not-be-logged');
  });

  it('logs successful state-changing requests with their action', async () => {
    const write = vi.fn<LogWriter>();
    const app = new Hono();
    app.use('/api/*', logApiRequests({ write }));
    app.post('/api/reviews', (context) =>
      context.json({ ok: true, action: 'pr_review_start', token: 'secret' }),
    );

    expect((await app.request('/api/reviews', { method: 'POST' })).status).toBe(
      200,
    );
    expect(write).toHaveBeenCalledWith(
      'info',
      expect.stringContaining('action    pr_review_start'),
    );
    expect(write.mock.calls[0]?.[1]).not.toContain('secret');
  });

  it('suppresses routine successful reads unless verbose or slow', async () => {
    const quietWrite = vi.fn<LogWriter>();
    const quietApp = new Hono();
    quietApp.use('/api/*', logApiRequests({ write: quietWrite }));
    quietApp.get('/api/health', (context) => context.json({ ok: true }));
    await quietApp.request('/api/health');
    expect(quietWrite).not.toHaveBeenCalled();

    const verboseWrite = vi.fn<LogWriter>();
    const verboseApp = new Hono();
    verboseApp.use(
      '/api/*',
      logApiRequests({ logSuccessfulReads: true, write: verboseWrite }),
    );
    verboseApp.get('/api/health', (context) => context.json({ ok: true }));
    await verboseApp.request('/api/health');
    expect(verboseWrite).toHaveBeenCalledWith(
      'info',
      expect.stringContaining('HTTP GET /api/health 200'),
    );

    const slowWrite = vi.fn<LogWriter>();
    const now = vi
      .fn<() => number>()
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(1_510);
    const slowApp = new Hono();
    slowApp.use('/api/*', logApiRequests({ now, write: slowWrite }));
    slowApp.get('/api/health', (context) => context.json({ ok: true }));
    await slowApp.request('/api/health');
    expect(slowWrite).toHaveBeenCalledWith(
      'info',
      '[neondeck] HTTP GET /api/health 200 1500ms',
    );
  });

  it('flattens line breaks and bounds diagnostic fields', () => {
    const output = formatApiRequest({
      method: 'post',
      path: '/api/demo\n[forged]',
      status: 503,
      durationMs: 2,
      message: `upstream\nfailed \u001b]8;;https://example.com\u0007link\u001b]8;;\u0007 \u009b31mred`,
      errors: ['x'.repeat(1_000)],
    });

    expect(output).toContain('message   upstream failed');
    expect(output).not.toContain('\nfailed');
    expect(output).not.toContain('\n[forged]');
    expect(output).not.toContain('\u001b');
    expect(output).not.toContain('\u0007');
    expect(output).not.toContain('\u009b');
    expect(output.length).toBeLessThan(1_000);
  });
});

describe('Flue activity logging', () => {
  it('logs submission lifecycle milestones without payloads', () => {
    expect(
      formatFlueActivity({
        v: 3,
        type: 'submission_queued',
        eventIndex: 1,
        timestamp: '2026-08-17T19:00:00.000Z',
        submissionId: 'submission-1',
        agentName: 'review-pr-for-human',
        instanceId: 'review-1',
        kind: 'dispatch',
      }),
    ).toEqual({
      level: 'info',
      message:
        '[neondeck] ACTIVITY submission queued agent=review-pr-for-human submission=submission-1 kind=dispatch',
    });

    expect(
      formatFlueActivity({
        v: 3,
        type: 'submission_settled',
        eventIndex: 2,
        timestamp: '2026-08-17T19:00:02.000Z',
        submissionId: 'submission-1',
        agentName: 'review-pr-for-human',
        instanceId: 'review-1',
        outcome: 'failed',
        error: { name: 'GitHubError', message: 'token must stay private' },
      } as FlueObservation),
    ).toEqual({
      level: 'warn',
      message:
        '[neondeck] ACTIVITY submission settled agent=review-pr-for-human submission=submission-1 outcome=failed error=GitHubError',
    });
  });

  it('ignores noisy nested log events', () => {
    expect(
      formatFlueActivity({
        v: 3,
        type: 'log',
        eventIndex: 3,
        timestamp: '2026-08-17T19:00:01.000Z',
        submissionId: 'submission-1',
        level: 'info',
        message: 'payload-like activity',
      } as FlueObservation),
    ).toBeNull();
  });
});
