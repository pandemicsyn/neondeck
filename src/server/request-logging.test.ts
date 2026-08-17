import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { formatFailedRequest, logFailedApiRequests } from './request-logging';

describe('failed API request logging', () => {
  it('logs only sanitized action diagnostics from failed JSON responses', async () => {
    const write = vi.fn<(level: 'error' | 'warn', message: string) => void>();
    const now = vi
      .fn<() => number>()
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(118);
    const app = new Hono();
    app.use('/api/*', logFailedApiRequests({ now, write }));
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

  it('does not log successful requests', async () => {
    const write = vi.fn<(level: 'error' | 'warn', message: string) => void>();
    const app = new Hono();
    app.use('/api/*', logFailedApiRequests({ write }));
    app.get('/api/health', (context) => context.json({ ok: true }));

    expect((await app.request('/api/health')).status).toBe(200);
    expect(write).not.toHaveBeenCalled();
  });

  it('flattens line breaks and bounds diagnostic fields', () => {
    const output = formatFailedRequest({
      method: 'post',
      path: '/api/demo',
      status: 503,
      durationMs: 2,
      message: `upstream\nfailed`,
      errors: ['x'.repeat(1_000)],
    });

    expect(output).toContain('message   upstream failed');
    expect(output).not.toContain('\nfailed');
    expect(output.length).toBeLessThan(900);
  });
});
