import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
});
