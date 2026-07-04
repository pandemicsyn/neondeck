import { describe, expect, it } from 'vitest';
import {
  findChromiumBrowser,
  resolveWindowProfile,
  waitForHealth,
} from './open';

describe('desktop open launcher', () => {
  it('merges window profiles with CLI overrides', () => {
    expect(
      resolveWindowProfile(
        {
          sidebar: { width: 480, height: 1400, x: 0, y: 25 },
        },
        'sidebar',
        { width: 520, kiosk: true },
      ),
    ).toEqual({
      width: 520,
      height: 1400,
      x: 0,
      y: 25,
      kiosk: true,
    });
  });

  it('reports unknown profiles with available names', () => {
    expect(() =>
      resolveWindowProfile({ sidebar: { width: 480 } }, 'missing'),
    ).toThrow('Available: sidebar');
  });

  it('rejects partial geometry that Chromium would ignore', () => {
    expect(() =>
      resolveWindowProfile({ sidebar: { width: 480 } }, 'sidebar'),
    ).toThrow('width and height together');
    expect(() => resolveWindowProfile({}, undefined, { x: 10 })).toThrow(
      'x and y together',
    );
  });

  it('detects Chromium-family browsers from injected filesystem state', () => {
    const browser = findChromiumBrowser({
      platform: 'linux',
      env: { PATH: '/bin:/opt/bin' },
      exists: (path) => path === '/opt/bin/chromium',
    });

    expect(browser).toEqual({
      id: 'chromium',
      name: 'Chromium',
      path: '/opt/bin/chromium',
    });
  });

  it('waits for health until a later probe succeeds', async () => {
    let calls = 0;
    const result = await waitForHealth('http://127.0.0.1:3583', {
      intervalMs: 1,
      timeoutMs: 50,
      fetch: (async () => {
        calls += 1;
        return new Response(null, { status: calls >= 3 ? 200 : 503 });
      }) as typeof fetch,
    });

    expect(result.ok).toBe(true);
    expect(calls).toBe(3);
  });
});
