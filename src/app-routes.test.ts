import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
      ]),
    );
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
});
