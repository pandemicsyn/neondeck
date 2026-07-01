import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { publishConfigEvent, type ConfigChangeEvent } from './config-events';

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
          id: 'prepare-pr-worktree',
          primitive: 'workflow',
        }),
        expect.objectContaining({
          id: 'fix-pr-ci-failure',
          primitive: 'workflow',
        }),
        expect.objectContaining({
          id: '/api/autopilot/prepare-pr-worktree',
          primitive: 'route',
        }),
        expect.objectContaining({
          id: '/api/autopilot/fix-pr-ci-failure',
          primitive: 'route',
        }),
      ]),
    );
  });

  it('serves autopilot operator state over the local API', async () => {
    const response = await app.request('http://localhost/api/autopilot/state', {
      headers: { host: 'localhost' },
    });
    const body = (await response.json()) as {
      ok: boolean;
      action: string;
      queue: unknown[];
      policies: {
        global: { mode: string };
      };
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      action: 'autopilot_state_read',
      policies: {
        global: { mode: 'notify-only' },
      },
    });
    expect(Array.isArray(body.queue)).toBe(true);
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

  it('serves config events as a local server-sent event stream', async () => {
    const response = await app.request('http://localhost/api/events/config', {
      headers: { host: 'localhost' },
    });

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

    const response = await app.request('http://localhost/api/events/config', {
      headers: {
        host: 'localhost',
        'last-event-id': previousEvent.id,
      },
    });

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

  it('serves notification events as a local server-sent event stream', async () => {
    const response = await app.request(
      'http://localhost/api/events/notifications',
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

  it('serves session events as a local server-sent event stream', async () => {
    const response = await app.request('http://localhost/api/events/sessions', {
      headers: { host: 'localhost' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const chunk = await reader!.read();
    expect(new TextDecoder().decode(chunk.value)).toContain(': connected');
    await reader!.cancel();
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

  it('returns a client error when memory delete is not confirmed', async () => {
    const response = await app.request(
      'http://localhost/api/memories?scope=session&key=current-task',
      {
        method: 'DELETE',
        headers: {
          host: 'localhost',
          origin: 'http://localhost',
        },
      },
    );
    const body = (await response.json()) as {
      ok: boolean;
      requires?: string[];
    };

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      ok: false,
      requires: ['confirm'],
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

  it('serves PR event autopilot triage over the local API', async () => {
    const response = await app.request(
      'http://localhost/api/autopilot/triage-pr-event',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          host: 'localhost',
          origin: 'http://localhost',
        },
        body: JSON.stringify({
          repoId: 'sample',
          prNumber: 1,
          autopilotMode: 'draft-fix',
          deltas: [{ type: 'check-failure', actionable: true }],
          current: { state: 'open', checkStatus: 'failure' },
        }),
      },
    );
    const body = (await response.json()) as {
      ok: boolean;
      data?: { classification?: string };
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      data: { classification: 'draft-fix' },
    });
  });

  it('rejects caller-supplied PR facts on the prepare worktree API', async () => {
    const response = await app.request(
      'http://localhost/api/autopilot/prepare-pr-worktree',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          host: 'localhost',
          origin: 'http://localhost',
        },
        body: JSON.stringify({
          repoId: 'sample',
          prNumber: 1,
          pr: { headSha: 'fabricated' },
          checks: { status: 'success' },
        }),
      },
    );
    const body = (await response.json()) as {
      ok: boolean;
      message?: string;
    };

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      ok: false,
      message: 'Invalid autopilot input.',
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
