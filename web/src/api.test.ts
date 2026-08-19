import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  archiveMemory,
  archivePrReview,
  getChatSessions,
  getActivitySubmission,
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

  it('archives memory through the audited endpoint with explicit confirmation', async () => {
    const fetchMock = vi.fn<
      (input: string | URL | Request, init?: RequestInit) => Promise<Response>
    >(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            action: 'memory_archive',
            changed: true,
            message: 'Archived durable memory.',
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await archiveMemory('memory/1', {
      expectedUpdatedAt: '2026-07-30T00:00:00.000Z',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/memories/memory%2F1/archive',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          reason: 'Archived from the Memory dashboard.',
          confirm: true,
          expectedUpdatedAt: '2026-07-30T00:00:00.000Z',
        }),
      }),
    );
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

  it('reads sanitized submission activity from the local API', async () => {
    const fetchMock = vi.fn<
      (input: string | URL | Request, init?: RequestInit) => Promise<Response>
    >(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            action: 'activity_submission_read',
            submission: {
              submissionId: 'sub_123',
              status: 'completed',
            },
            events: [],
            fetchedAt: '2026-07-21T16:01:00.000Z',
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      getActivitySubmission('sub_123', { afterEventId: 41 }),
    ).resolves.toMatchObject({
      submission: { submissionId: 'sub_123' },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/activity/submissions/sub_123?afterEventId=41',
    );
  });
});
