import { describe, expect, it } from 'vitest';
import {
  findChromiumBrowser,
  resolveOpenPort,
  resolveWindowProfile,
  serviceMatchesRuntimeHome,
  waitForHealth,
} from './open';
import type { ServiceStatus } from './service';

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

  it('only adopts an installed service port for the same runtime home', () => {
    const previousNeondeckPort = process.env.NEONDECK_PORT;
    const previousPort = process.env.PORT;
    delete process.env.NEONDECK_PORT;
    delete process.env.PORT;
    try {
      const status: ServiceStatus = {
        platform: 'linux',
        supported: true,
        installed: true,
        running: true,
        unitPath: '/home/tester/.config/systemd/user/neondeck.service',
        logPath: '/home/tester/.config/neondeck/data/logs/server.log',
        port: 4599,
        health: { ok: true, url: 'http://127.0.0.1:4599/api/health' },
        runtimeHome: '/home/tester/.config/neondeck',
        warnings: [],
      };

      expect(
        resolveOpenPort(undefined, status, '/home/tester/.config/neondeck'),
      ).toBe(4599);
      expect(resolveOpenPort(undefined, status, '/tmp/other-home')).toBe(3583);
      expect(serviceMatchesRuntimeHome(status, '/tmp/other-home')).toBe(false);
    } finally {
      if (previousNeondeckPort === undefined) {
        delete process.env.NEONDECK_PORT;
      } else {
        process.env.NEONDECK_PORT = previousNeondeckPort;
      }
      if (previousPort === undefined) {
        delete process.env.PORT;
      } else {
        process.env.PORT = previousPort;
      }
    }
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
