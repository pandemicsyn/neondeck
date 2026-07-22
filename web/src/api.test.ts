import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  archivePrReview,
  getChatSessions,
  getWorkflowRun,
  learningOperatorStateUrl,
  restorePrReview,
} from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('dashboard API helpers', () => {
  it('targets reversible PR review archive endpoints', async () => {
    const fetchMock = vi.fn<
      (input: string | URL | Request, init?: RequestInit) => Promise<Response>
    >(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            changed: true,
            review: {},
            reviewId: 'review/1',
            runId: '',
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await archivePrReview('review/1');
    await restorePrReview('review/1');

    expect(fetchMock.mock.calls.map(([input]) => input)).toEqual([
      '/api/reviews/review%2F1/archive',
      '/api/reviews/review%2F1/restore',
    ]);
  });

  it('builds learning operator candidate filters before limit', () => {
    expect(
      learningOperatorStateUrl({
        candidateStatus: 'proposed',
        candidateTarget: 'skill',
        limit: 3,
      }),
    ).toBe(
      '/api/learning/state?candidateStatus=proposed&candidateTarget=skill&limit=3',
    );
  });

  it('forwards query cancellation to the underlying request', async () => {
    const signal = new AbortController().signal;
    const fetchMock = vi.fn<
      (input: string | URL | Request, init?: RequestInit) => Promise<Response>
    >(
      async () =>
        new Response(JSON.stringify({ sessions: [] }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await getChatSessions({}, { signal });

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions', { signal });
  });

  it('reads workflow runs with the local inspection token in a header', async () => {
    const fetchMock = vi.fn<
      (input: string | URL | Request, init?: RequestInit) => Promise<Response>
    >(async (input) => {
      if (input === '/api/local-api/session') {
        return new Response(
          JSON.stringify({
            ok: true,
            token: 'local-token',
            header: 'x-neondeck-api-token',
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          ok: true,
          action: 'workflow_run_inspection_read',
          run: {
            runId: 'run_123',
            workflowName: 'command-run',
            status: 'completed',
            startedAt: '2026-07-21T16:00:00.000Z',
          },
          fetchedAt: '2026-07-21T16:01:00.000Z',
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getWorkflowRun('run_123')).resolves.toMatchObject({
      run: { runId: 'run_123' },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const inspectionRequest = fetchMock.mock.calls[1];
    expect(inspectionRequest?.[0]).toBe('/api/workflows/runs/run_123');
    const inspectionHeaders = new Headers(inspectionRequest?.[1]?.headers);
    expect(inspectionHeaders.get('x-neondeck-api-token')).toBe('local-token');
  });
});
