import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dashboardEventStreamPath } from '../shared/dashboard-events';
import { publishConfigEvent, type ConfigChangeEvent } from './modules/config';
import { createMemoryCandidate } from './modules/memory';

const originalEnv = { ...process.env };
let home: string;
let app: Awaited<typeof import('./app')>['default'];

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'neondeck-app-'));
  process.env.NEONDECK_HOME = home;
  process.env.NEONDECK_DISABLE_SCHEDULER = '1';
  app = (await import('./app')).default;
});

afterAll(async () => {
  process.env = { ...originalEnv };
  await rm(home, { recursive: true, force: true });
});

describe('app API safety routes', () => {
  it('reads, updates, and resets Autopilot owner prompts', async () => {
    const readResponse = await app.request(
      'http://localhost/api/autopilot/prompts',
      { headers: { host: 'localhost' } },
    );
    const initial = (await readResponse.json()) as {
      data: {
        prompts: Record<string, string>;
        overrides: Record<string, string>;
      };
    };
    expect(readResponse.status).toBe(200);
    expect(initial.data.prompts['prepare-only']).toContain(
      'private continuing Neondeck owner',
    );

    const updateResponse = await app.request(
      'http://localhost/api/autopilot/prompts',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          host: 'localhost',
          origin: 'http://localhost',
        },
        body: JSON.stringify({
          mode: 'prepare-only',
          prompt: 'Route prompt {{mode}}',
        }),
      },
    );
    expect(updateResponse.status).toBe(200);
    expect(await updateResponse.json()).toMatchObject({
      ok: true,
      changed: true,
      data: { overrides: { 'prepare-only': 'Route prompt {{mode}}' } },
    });

    const resetResponse = await app.request(
      'http://localhost/api/autopilot/prompts',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          host: 'localhost',
          origin: 'http://localhost',
        },
        body: JSON.stringify({ mode: 'prepare-only', prompt: null }),
      },
    );
    expect(resetResponse.status).toBe(200);
    expect(await resetResponse.json()).toMatchObject({
      ok: true,
      changed: true,
      data: { overrides: {} },
    });
  });

  it('reads, updates, and resets PR reviewer prompts', async () => {
    const readResponse = await app.request(
      'http://localhost/api/pr-review/prompts',
      { headers: { host: 'localhost' } },
    );
    const initial = (await readResponse.json()) as {
      data: {
        prompts: Record<string, string>;
        overrides: Record<string, string>;
      };
    };
    expect(readResponse.status).toBe(200);
    expect(initial.data.prompts['initial-review']).toContain(
      'private Neondeck reviewer',
    );

    const updateResponse = await app.request(
      'http://localhost/api/pr-review/prompts',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          host: 'localhost',
          origin: 'http://localhost',
        },
        body: JSON.stringify({
          kind: 'follow-up-reviewer',
          prompt: 'Route reviewer prompt {{reviewContext}}',
        }),
      },
    );
    expect(updateResponse.status).toBe(200);
    expect(await updateResponse.json()).toMatchObject({
      ok: true,
      changed: true,
      data: {
        overrides: {
          'follow-up-reviewer': 'Route reviewer prompt {{reviewContext}}',
        },
      },
    });

    const resetResponse = await app.request(
      'http://localhost/api/pr-review/prompts',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          host: 'localhost',
          origin: 'http://localhost',
        },
        body: JSON.stringify({ kind: 'follow-up-reviewer', prompt: null }),
      },
    );
    expect(resetResponse.status).toBe(200);
    expect(await resetResponse.json()).toMatchObject({
      ok: true,
      changed: true,
      data: { overrides: {} },
    });
  });

  it('serves safety policy over the local API', async () => {
    const response = await app.request('http://localhost/api/safety/policy', {
      headers: { host: 'localhost' },
    });
    const body = (await response.json()) as {
      ok: boolean;
      entries: Array<{ id: string; primitive: string }>;
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'neondeck_safety_policy_lookup',
          primitive: 'tool',
        }),
        expect.objectContaining({
          id: 'fix-pr-ci',
          primitive: 'workflow',
        }),
        expect.objectContaining({
          id: 'neondeck_autopilot_watch_status',
          primitive: 'action',
        }),
        expect.objectContaining({
          id: '/api/watches/autopilot',
          primitive: 'route',
        }),
        expect.objectContaining({
          id: '/api/watches/:id/autopilot',
          primitive: 'route',
        }),
        expect.objectContaining({
          id: '/api/watches/:id/autopilot/message',
          primitive: 'route',
        }),
      ]),
    );
  });

  it('does not mount retired Autopilot transition routes', async () => {
    for (const path of [
      '/api/autopilot/state',
      '/api/autopilot/readiness',
      '/api/autopilot/triage-pr-event',
      '/api/autopilot/prepare-pr-worktree',
      '/api/autopilot/fix-pr-ci-failure',
      '/api/autopilot/fix-pr-review-feedback',
      '/api/autopilot/verify-pr-worktree',
      '/api/autopilot/push-pr-autofix',
      '/api/autopilot/comment-pr-autofix-result',
    ]) {
      const response = await app.request(`http://localhost${path}`, {
        method: 'POST',
        headers: { host: 'localhost', 'content-type': 'application/json' },
        body: '{}',
      });
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
    }
  });

  it('serves the saved local API token to the local dashboard session', async () => {
    const response = await app.request(
      'http://localhost/api/local-api/session',
      {
        headers: { host: 'localhost' },
      },
    );
    const body = (await response.json()) as {
      ok: boolean;
      action: string;
      token: string;
      header: string;
      queryParam: string;
    };
    const config = JSON.parse(
      await readFile(join(home, 'config.json'), 'utf8'),
    ) as {
      localApi?: { token?: string };
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      action: 'local_api_session_read',
      header: 'x-neondeck-api-token',
      queryParam: 'neondeckApiToken',
    });
    expect(body.token).toBe(config.localApi?.token);
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
  });

  it('hides raw Flue run inspection without the local API token', async () => {
    const response = await app.request(
      'http://localhost/api/flue/runs/missing?meta',
      {
        headers: { host: 'localhost' },
      },
    );

    expect(response.status).toBe(404);
  });

  it('hides app-owned workflow run inspection without the local API token', async () => {
    const response = await app.request(
      'http://localhost/api/workflows/runs/missing',
      {
        headers: { host: 'localhost' },
      },
    );

    expect(response.status).toBe(404);
  });

  it('returns prepared-diff API validation errors as bad requests', async () => {
    const listResponse = await app.request(
      'http://localhost/api/prepared-diffs?status=bogus',
      {
        headers: { host: 'localhost' },
      },
    );
    const diffResponse = await app.request(
      'http://localhost/api/prepared-diffs/missing/files/diff',
      {
        headers: { host: 'localhost' },
      },
    );

    expect(listResponse.status).toBe(400);
    expect(diffResponse.status).toBe(400);
  });

  it('routes ref-watch creation before dynamic watch removal', async () => {
    const response = await app.request('http://localhost/api/watches/ref', {
      method: 'POST',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      body: '{}',
    });
    const body = (await response.json()) as { action: string };

    expect(response.status).toBe(400);
    expect(body.action).toMatch(/^watch_ref_/);
  });

  it('requires attribution on handoff API requests', async () => {
    const response = await app.request(
      'http://localhost/api/handoff/register-pr',
      {
        method: 'POST',
        headers: { host: 'localhost', 'content-type': 'application/json' },
        body: JSON.stringify({ ref: 'neondeck#123' }),
      },
    );
    const body = (await response.json()) as {
      ok: boolean;
      requires?: string[];
    };

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      ok: false,
      requires: ['source'],
    });
  });

  it('creates attributed handoff notes over the local API', async () => {
    const response = await app.request('http://localhost/api/handoff/note', {
      method: 'POST',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'codex',
        text: 'Local handoff note.',
        level: 'ready',
      }),
    });
    const body = (await response.json()) as {
      ok: boolean;
      action: string;
      notification?: { source?: string; message?: string };
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      action: 'handoff_note_create',
      notification: {
        source: 'external:codex',
        message: 'Local handoff note.',
      },
    });
  });

  it('serves app events as one local server-sent event stream', async () => {
    const response = await app.request(
      `http://localhost${dashboardEventStreamPath}`,
      {
        headers: { host: 'localhost' },
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const chunk = await reader!.read();
    expect(new TextDecoder().decode(chunk.value)).toContain(': connected');
    await reader!.cancel();
  });

  it('replays config events missed during a server-sent event reconnect', async () => {
    const previousEvent: ConfigChangeEvent = {
      id: `test-replay-before-${Date.now()}`,
      action: 'config_reload',
      changed: false,
      home,
      files: [],
      target: 'all',
      changedAt: new Date().toISOString(),
    };
    const missedEvent: ConfigChangeEvent = {
      id: `test-replay-after-${Date.now()}`,
      action: 'config_update_dashboard_layout',
      changed: true,
      home,
      files: ['dashboard.json'],
      target: 'dashboard',
      changedAt: new Date().toISOString(),
    };
    publishConfigEvent(previousEvent);
    publishConfigEvent(missedEvent);

    const response = await app.request(
      `http://localhost${dashboardEventStreamPath}`,
      {
        headers: {
          host: 'localhost',
          'last-event-id': previousEvent.id,
        },
      },
    );

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const decoder = new TextDecoder();
    let output = '';
    for (
      let readCount = 0;
      readCount < 4 && !output.includes(missedEvent.id);
      readCount += 1
    ) {
      const chunk = await reader!.read();
      if (chunk.value) output += decoder.decode(chunk.value);
    }

    expect(output).toContain(`id: ${missedEvent.id}`);
    expect(output).toContain('event: config-change');
    await reader!.cancel();
  });

  it('serves durable PR reviews', async () => {
    const listResponse = await app.request('http://localhost/api/reviews', {
      headers: { host: 'localhost' },
    });
    const list = (await listResponse.json()) as {
      ok: boolean;
      groups: { inProgress: unknown[]; needsAction: unknown[] };
    };
    expect(listResponse.status).toBe(200);
    expect(list).toMatchObject({
      ok: true,
      groups: { inProgress: [], needsAction: [] },
    });
  });

  it('rejects cross-origin app API mutations', async () => {
    const response = await app.request('http://localhost/api/models', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        host: 'localhost',
        origin: 'https://example.invalid',
      },
      body: '{}',
    });

    expect(response.status).toBe(404);
  });

  it('validates learning review API inputs before workflow admission', async () => {
    const badReview = await app.request(
      'http://localhost/api/learning/reviews/conversation',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          host: 'localhost',
          origin: 'http://localhost',
        },
        body: JSON.stringify({ sessionId: '' }),
      },
    );
    const missingSession = await app.request(
      'http://localhost/api/learning/reviews/conversation',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          host: 'localhost',
          origin: 'http://localhost',
        },
        body: JSON.stringify({ sessionId: 'missing-session' }),
      },
    );
    const badLimit = await app.request(
      'http://localhost/api/learning/reviews?limit=-1',
      {
        headers: { host: 'localhost' },
      },
    );
    const badPrReview = await app.request(
      'http://localhost/api/learning/reviews/prs',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          host: 'localhost',
          origin: 'http://localhost',
        },
        body: JSON.stringify({ limit: 0 }),
      },
    );
    const badSkillPatchList = await app.request(
      'http://localhost/api/skills/patches?status=bogus',
      {
        headers: { host: 'localhost' },
      },
    );
    const badCandidateLimit = await app.request(
      'http://localhost/api/learning/candidates?limit=bogus',
      {
        headers: { host: 'localhost' },
      },
    );
    const badLearningState = await app.request(
      'http://localhost/api/learning/state?candidateTarget=bogus',
      {
        headers: { host: 'localhost' },
      },
    );
    const badPatchLimit = await app.request(
      'http://localhost/api/skills/patches?limit=0',
      {
        headers: { host: 'localhost' },
      },
    );

    expect(badReview.status).toBe(400);
    expect(missingSession.status).toBe(400);
    expect(badLimit.status).toBe(400);
    expect(badPrReview.status).toBe(400);
    expect(badSkillPatchList.status).toBe(400);
    expect(badCandidateLimit.status).toBe(400);
    expect(badPatchLimit.status).toBe(400);
    await expect(badReview.json()).resolves.toMatchObject({
      ok: false,
      action: 'learning_review_conversation',
    });
    await expect(missingSession.json()).resolves.toMatchObject({
      ok: false,
      action: 'session_read',
    });
    await expect(badLimit.json()).resolves.toMatchObject({
      ok: false,
      action: 'learning_review_list',
    });
    await expect(badPrReview.json()).resolves.toMatchObject({
      ok: false,
      action: 'learning_review_pr_batch',
    });
    await expect(badSkillPatchList.json()).resolves.toMatchObject({
      ok: false,
      action: 'skill_patch_list',
    });
    await expect(badCandidateLimit.json()).resolves.toMatchObject({
      ok: false,
      action: 'learning_candidate_list',
    });
    await expect(badLearningState.json()).resolves.toMatchObject({
      ok: false,
      action: 'learning_operator_state',
    });
    await expect(badPatchLimit.json()).resolves.toMatchObject({
      ok: false,
      action: 'skill_patch_list',
    });
  });

  it('preserves memory candidate errors on combined candidate decisions', async () => {
    const headers = {
      'content-type': 'application/json',
      host: 'localhost',
      origin: 'http://localhost',
    };
    const applyCandidate = await createMemoryCandidate({
      action: 'upsert',
      scope: 'local',
      key: `route-apply-${Date.now()}`,
      value: 'durable route candidate',
      reason: 'route regression test',
    });
    if (!applyCandidate.ok || !('candidate' in applyCandidate)) {
      throw new Error(applyCandidate.message);
    }
    const applyId = String(applyCandidate.candidate.id);

    const firstApply = await app.request(
      `http://localhost/api/learning/candidates/${applyId}/approve`,
      {
        method: 'POST',
        headers,
        body: '{}',
      },
    );
    const secondApply = await app.request(
      `http://localhost/api/learning/candidates/${applyId}/approve`,
      {
        method: 'POST',
        headers,
        body: '{}',
      },
    );
    const secondApplyBody = (await secondApply.json()) as {
      action?: string;
      message?: string;
    };

    expect(firstApply.status).toBe(200);
    expect(secondApply.status).toBe(400);
    expect(secondApplyBody).toMatchObject({
      action: 'memory_candidate_decide',
      message: 'Memory candidate was already decided.',
    });

    const rejectCandidate = await createMemoryCandidate({
      action: 'upsert',
      scope: 'local',
      key: `route-reject-${Date.now()}`,
      value: 'reject route candidate',
      reason: 'route regression test',
    });
    if (!rejectCandidate.ok || !('candidate' in rejectCandidate)) {
      throw new Error(rejectCandidate.message);
    }
    const rejectId = String(rejectCandidate.candidate.id);

    const firstReject = await app.request(
      `http://localhost/api/learning/candidates/${rejectId}/reject`,
      {
        method: 'POST',
        headers,
        body: '{}',
      },
    );
    const secondReject = await app.request(
      `http://localhost/api/learning/candidates/${rejectId}/reject`,
      {
        method: 'POST',
        headers,
        body: '{}',
      },
    );
    const secondRejectBody = (await secondReject.json()) as {
      action?: string;
      message?: string;
    };

    expect(firstReject.status).toBe(200);
    expect(secondReject.status).toBe(400);
    expect(secondRejectBody).toMatchObject({
      action: 'memory_candidate_decide',
      message: 'Memory candidate was already decided.',
    });
  });

  it('returns structured GitHub PR queue errors', async () => {
    const token = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      const response = await app.request('http://localhost/api/github/prs', {
        headers: { host: 'localhost' },
      });
      const body = (await response.json()) as {
        error?: string;
        items?: unknown[];
        issues?: Array<{ message: string }>;
      };

      expect(response.status).toBe(503);
      expect(body).toMatchObject({
        error: 'GITHUB_TOKEN is not configured.',
        items: [],
      });
      expect(body.issues?.[0]?.message).toBe('GITHUB_TOKEN is not configured.');
    } finally {
      if (token === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = token;
      }
    }
  });

  it('serves single PR metadata over the local GitHub API route', async () => {
    const token = process.env.GITHUB_TOKEN;
    const previousFetch = globalThis.fetch;
    process.env.GITHUB_TOKEN = 'server-token';
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer server-token',
      });
      const url = String(input);
      if (
        url === 'https://api.github.com/repos/pandemicsyn/neondeck/pulls/123'
      ) {
        return new Response(
          JSON.stringify({
            number: 123,
            title: 'Review workbench',
            body: 'Review body',
            html_url: 'https://github.com/pandemicsyn/neondeck/pull/123',
            state: 'open',
            draft: false,
            user: { login: 'pandemicsyn' },
            labels: [{ name: 'ui' }],
            comments: 4,
            merged: false,
            merge_commit_sha: null,
            updated_at: '2026-07-05T14:00:00Z',
            created_at: '2026-07-04T14:00:00Z',
            head: { sha: 'head123', ref: 'feature/review-popout' },
            base: { sha: 'base123', ref: 'main' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (
        url ===
        'https://api.github.com/repos/pandemicsyn/neondeck/commits/head123/check-runs?per_page=100'
      ) {
        return new Response(JSON.stringify({ check_runs: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (
        url ===
        'https://api.github.com/repos/pandemicsyn/neondeck/commits/head123/status'
      ) {
        return new Response(JSON.stringify({ statuses: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected GitHub fetch: ${url}`);
    });
    globalThis.fetch = fetchMock;
    try {
      const response = await app.request(
        'http://localhost/api/github/prs/pandemicsyn/neondeck/123',
        { headers: { host: 'localhost' } },
      );
      const body = (await response.json()) as {
        ok: boolean;
        data?: {
          pullRequest?: {
            repo?: string;
            number?: number;
            title?: string;
            headSha?: string | null;
            baseRef?: string | null;
          };
        };
      };

      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(body).toMatchObject({
        ok: true,
        data: {
          pullRequest: {
            repo: 'pandemicsyn/neondeck',
            number: 123,
            title: 'Review workbench',
            headSha: 'head123',
            baseRef: 'main',
          },
        },
      });
    } finally {
      globalThis.fetch = previousFetch;
      if (token === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = token;
      }
    }
  });

  it('serves single PR metadata when check enrichment fails', async () => {
    const token = process.env.GITHUB_TOKEN;
    const previousFetch = globalThis.fetch;
    process.env.GITHUB_TOKEN = 'server-token';
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (
        url === 'https://api.github.com/repos/pandemicsyn/neondeck/pulls/123'
      ) {
        return new Response(
          JSON.stringify({
            id: 1001,
            number: 123,
            title: 'Review workbench',
            html_url: 'https://github.com/pandemicsyn/neondeck/pull/123',
            state: 'open',
            draft: false,
            merged: false,
            merge_commit_sha: null,
            updated_at: '2026-07-05T14:00:00Z',
            created_at: '2026-07-04T14:00:00Z',
            head: { sha: 'head123' },
            base: { ref: 'main' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ message: 'checks unavailable' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    });
    globalThis.fetch = fetchMock;
    try {
      const response = await app.request(
        'http://localhost/api/github/prs/pandemicsyn/neondeck/123',
        { headers: { host: 'localhost' } },
      );
      const body = (await response.json()) as {
        ok: boolean;
        data?: {
          pullRequest?: {
            checkError?: string;
            checks?: unknown;
            title?: string;
          };
        };
      };

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.data?.pullRequest).toMatchObject({
        title: 'Review workbench',
        checks: null,
      });
      expect(body.data?.pullRequest?.checkError).toContain(
        'checks unavailable',
      );
    } finally {
      globalThis.fetch = previousFetch;
      if (token === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = token;
      }
    }
  });

  it('serves PR file diffs over the local GitHub API route without browser tokens', async () => {
    const token = process.env.GITHUB_TOKEN;
    const previousFetch = globalThis.fetch;
    process.env.GITHUB_TOKEN = 'server-token';
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer server-token',
      });
      const url = String(input);
      if (
        url === 'https://api.github.com/repos/pandemicsyn/neondeck/pulls/123'
      ) {
        return new Response(
          JSON.stringify({
            number: 123,
            title: 'PR 123',
            html_url: 'https://github.com/pandemicsyn/neondeck/pull/123',
            state: 'open',
            draft: false,
            merged: false,
            merge_commit_sha: null,
            updated_at: '2026-07-05T14:00:00Z',
            head: { sha: 'head123' },
            base: { ref: 'main', sha: 'base123' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      expect(url).toContain(
        'https://api.github.com/repos/pandemicsyn/neondeck/pulls/123/files',
      );
      return new Response(
        JSON.stringify([
          {
            sha: 'sha-a',
            filename: 'src/app.ts',
            status: 'modified',
            additions: 2,
            deletions: 1,
            changes: 3,
            patch: '@@ -1 +1 @@\n-old\n+new\n+another',
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    globalThis.fetch = fetchMock;
    try {
      const response = await app.request(
        'http://localhost/api/github/prs/pandemicsyn/neondeck/123/files?head=head123&base=base123',
        { headers: { host: 'localhost' } },
      );
      const body = (await response.json()) as {
        ok: boolean;
        data?: { files?: Array<{ path?: string; patch?: string | null }> };
      };
      const cachedResponse = await app.request(
        'http://localhost/api/github/prs/pandemicsyn/neondeck/123/files?head=head123&base=base123',
        { headers: { host: 'localhost' } },
      );
      const cachedBody = (await cachedResponse.json()) as typeof body;

      expect(response.status).toBe(200);
      expect(cachedResponse.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(cachedBody).toEqual(body);
      expect(body).toMatchObject({
        ok: true,
        data: {
          files: [
            {
              path: 'src/app.ts',
              patch: expect.stringContaining(
                'diff --git a/src/app.ts b/src/app.ts',
              ),
            },
          ],
        },
      });
    } finally {
      globalThis.fetch = previousFetch;
      if (token === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = token;
      }
    }
  });

  it('labels invalid GitHub PR file-diff route inputs with the file-diff action', async () => {
    const response = await app.request(
      'http://localhost/api/github/prs/pandemicsyn/neondeck/not-a-number/files/diff?path=src/app.ts',
      { headers: { host: 'localhost' } },
    );
    const body = (await response.json()) as { action?: string; ok?: boolean };

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      ok: false,
      action: 'github_pr_file_diff_get',
    });
  });

  it('posts PR comments through the local GitHub API route without browser tokens', async () => {
    const token = process.env.GITHUB_TOKEN;
    const previousFetch = globalThis.fetch;
    process.env.GITHUB_TOKEN = 'server-token';
    await writeFile(
      join(home, 'repos.json'),
      `${JSON.stringify({
        repos: [
          {
            id: 'neondeck',
            github: { owner: 'pandemicsyn', name: 'neondeck' },
            path: '/src/neondeck',
            defaultBranch: 'main',
          },
        ],
      })}\n`,
    );
    globalThis.fetch = vi.fn<typeof fetch>(async (input, init) => {
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer server-token',
      });
      const url = String(input);
      if (url.endsWith('/pulls/123')) {
        return new Response(
          JSON.stringify({
            number: 123,
            title: 'Review feedback',
            html_url: 'https://github.com/pandemicsyn/neondeck/pull/123',
            state: 'open',
            draft: false,
            merged: false,
            merge_commit_sha: null,
            mergeable: true,
            mergeable_state: 'clean',
            maintainer_can_modify: true,
            updated_at: '2026-06-30T20:00:00Z',
            head: {
              sha: 'head-sha',
              ref: 'feature',
              repo: {
                full_name: 'pandemicsyn/neondeck',
                name: 'neondeck',
                owner: { login: 'pandemyn' },
              },
            },
            base: {
              sha: 'base-sha',
              ref: 'main',
              repo: { full_name: 'pandemicsyn/neondeck' },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/pulls/123/commits')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/pulls/123/reviews')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (
        url.includes('/issues/123/comments') &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/commits/head-sha/check-suites')) {
        return new Response(JSON.stringify({ check_suites: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/commits/head-sha/check-runs')) {
        return new Response(JSON.stringify({ check_runs: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/repos/pandemicsyn/neondeck')) {
        return new Response(
          JSON.stringify({
            full_name: 'pandemicsyn/neondeck',
            permissions: { push: true, pull: true },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.endsWith('/graphql')) {
        return new Response(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          id: 77,
          node_id: 'comment-node-77',
          html_url:
            'https://github.com/pandemicsyn/neondeck/pull/123#issuecomment-77',
          body: 'Addressed review feedback.',
          user: { login: 'neon' },
          created_at: '2026-06-30T21:00:00Z',
          updated_at: '2026-06-30T21:00:00Z',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    try {
      const response = await app.request(
        'http://localhost/api/github/prs/comment',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            host: 'localhost',
            origin: 'http://localhost',
          },
          body: JSON.stringify({
            repo: 'pandemicsyn/neondeck',
            prNumber: 123,
            body: 'Addressed review feedback.',
          }),
        },
      );
      const body = (await response.json()) as {
        ok: boolean;
        data?: { comment?: { id?: number } };
      };

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        ok: true,
        data: { comment: { id: 77 } },
      });
    } finally {
      globalThis.fetch = previousFetch;
      if (token === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = token;
      }
    }
  });
});
