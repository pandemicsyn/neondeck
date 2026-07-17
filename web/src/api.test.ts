import { afterEach, describe, expect, it, vi } from 'vitest';
import { getChatSessions, learningOperatorStateUrl } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('dashboard API helpers', () => {
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
});
