import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { runtimePaths } from '../runtime-home';
import {
  formatOpenServerExit,
  controlAttachedServer,
  openDashboard,
  openServerExitCode,
  openServerStoppedCleanly,
  resolveExplicitChromiumBrowser,
  resolveOpenPort,
  resolveWindowProfile,
  serviceMatchesRuntimeHome,
  stopAttachedServer,
  waitForHealth,
  type AttachedServerController,
  type AttachedServerExit,
} from './open';
import type { ServiceCommandResult, ServiceStatus } from './service';

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

  it('uses Chromium app mode only for an explicit existing browser path', () => {
    const exists = (path: string) => path === '/opt/bin/brave';

    expect(resolveExplicitChromiumBrowser(undefined, exists)).toBeNull();
    expect(
      resolveExplicitChromiumBrowser('/opt/bin/missing', exists),
    ).toBeNull();
    expect(resolveExplicitChromiumBrowser('/opt/bin/brave', exists)).toEqual({
      id: 'custom',
      name: 'Custom Chromium',
      path: '/opt/bin/brave',
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

  it('keeps a directly started server attached to the open command', async () => {
    const paths = runtimePaths('/tmp/neondeck-open-attached');
    const server = deferredServer();
    const browserSpawn = vi.fn<() => Promise<void>>(async () => undefined);
    const spawnServer = vi.fn<() => AttachedServerController>(
      () => server.controller,
    );
    let healthCalls = 0;

    const launch = await openDashboard(
      { paths, suppressServerOutput: true },
      {
        exists: () => true,
        fetch: healthAfterFirstFailure(() => healthCalls++),
        platform: 'linux',
        readProfiles: async () => ({}),
        readServiceStatus: async () => serviceStatus(),
        spawn: browserSpawn,
        spawnServer,
      },
    );

    expect(launch.result).toMatchObject({
      ok: true,
      server: { wasRunning: false, startedBy: 'attached-serve' },
      browser: { strategy: 'default-browser' },
      warnings: [],
    });
    expect(launch.serverExit).toBe(server.controller.exit);
    expect(browserSpawn).toHaveBeenCalledWith(
      'xdg-open',
      ['http://127.0.0.1:3583'],
      { detached: true },
    );
    expect(spawnServer).toHaveBeenCalledWith(
      process.execPath,
      expect.any(Array),
      expect.objectContaining({ suppressOutput: true }),
    );

    server.resolve({ code: null, signal: 'SIGINT' });
    await expect(launch.serverExit).resolves.toEqual({
      code: null,
      signal: 'SIGINT',
    });
  });

  it('starts an installed service without owning its lifecycle', async () => {
    const paths = runtimePaths('/tmp/neondeck-open-service');
    const startService = vi.fn<() => Promise<ServiceCommandResult>>(
      async () => ({
        ok: true,
        action: 'service_start',
        changed: true,
        message: 'Started Neondeck service.',
      }),
    );
    const spawnServer = vi.fn<() => AttachedServerController>();
    let healthCalls = 0;

    const launch = await openDashboard(
      { paths },
      {
        fetch: healthAfterFirstFailure(() => healthCalls++),
        platform: 'linux',
        readProfiles: async () => ({}),
        readServiceStatus: async () =>
          serviceStatus({
            installed: true,
            runtimeHome: paths.home,
          }),
        spawn: async () => undefined,
        spawnServer,
        startService,
      },
    );

    expect(startService).toHaveBeenCalledWith(paths);
    expect(spawnServer).not.toHaveBeenCalled();
    expect(launch.result.server.startedBy).toBe('service');
    expect(launch.serverExit).toBeUndefined();
  });

  it('stops an owned server when opening the browser fails', async () => {
    const paths = runtimePaths('/tmp/neondeck-open-browser-failure');
    const server = deferredServer({ resolveWhenStopped: true });
    let healthCalls = 0;

    const launch = await openDashboard(
      { paths },
      {
        exists: () => true,
        fetch: healthAfterFirstFailure(() => healthCalls++),
        platform: 'linux',
        readProfiles: async () => ({}),
        readServiceStatus: async () => serviceStatus(),
        spawn: async () => {
          throw new Error('browser unavailable');
        },
        spawnServer: () => server.controller,
      },
    );

    expect(launch.result.ok).toBe(false);
    expect(launch.result.errors).toEqual(['browser unavailable']);
    expect(server.stop).toHaveBeenCalledWith('SIGTERM');
    expect(launch.serverExit).toBeUndefined();
  });

  it('fails promptly when an attached server exits before becoming healthy', async () => {
    const paths = runtimePaths('/tmp/neondeck-open-startup-exit');
    const browserSpawn = vi.fn<() => Promise<void>>(async () => undefined);

    const launch = await openDashboard(
      { paths },
      {
        exists: () => true,
        fetch: (async () =>
          new Response(null, { status: 503 })) as typeof fetch,
        platform: 'linux',
        readProfiles: async () => ({}),
        readServiceStatus: async () => serviceStatus(),
        spawn: browserSpawn,
        spawnServer: () => ({
          exit: Promise.resolve({ code: 1, signal: null }),
          stop: vi.fn<() => void>(),
        }),
      },
    );

    expect(launch.result).toMatchObject({
      ok: false,
      server: { startedBy: 'attached-serve' },
      errors: ['Server exited before becoming ready (code 1).'],
    });
    expect(browserSpawn).not.toHaveBeenCalled();
    expect(launch.serverExit).toBeUndefined();
  });

  it('reports attached server shutdown outcomes', () => {
    expect(formatOpenServerExit({ code: null, signal: 'SIGINT' })).toBe(
      'Neondeck stopped.',
    );
    expect(openServerExitCode({ code: null, signal: 'SIGINT' })).toBe(130);
    expect(openServerStoppedCleanly({ code: 130, signal: null })).toBe(true);
    expect(formatOpenServerExit({ code: 130, signal: null })).toBe(
      'Neondeck stopped.',
    );
    expect(formatOpenServerExit({ code: 1, signal: null })).toBe(
      'Neondeck server stopped unexpectedly with code 1.',
    );
    expect(openServerExitCode({ code: 1, signal: null })).toBe(1);
  });

  it('controls and cleans up an attached child process', async () => {
    const sigintListeners = process.listenerCount('SIGINT');
    const sigtermListeners = process.listenerCount('SIGTERM');
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      killed: false,
      kill: vi.fn<() => boolean>(() => true),
    });
    const controller = controlAttachedServer(child);

    expect(process.listenerCount('SIGINT')).toBe(sigintListeners + 1);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners + 1);
    controller.stop('SIGTERM');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    child.emit('exit', 0, null);
    await expect(controller.exit).resolves.toEqual({ code: 0, signal: null });
    expect(process.listenerCount('SIGINT')).toBe(sigintListeners);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);
  });

  it('force-kills an attached child when interactive shutdown stalls', async () => {
    vi.useFakeTimers();
    const previousListeners = new Set(process.listeners('SIGINT'));
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      killed: false,
      kill: vi.fn<() => boolean>(() => true),
    });
    const controller = controlAttachedServer(child);
    const interrupt = process
      .listeners('SIGINT')
      .find((listener) => !previousListeners.has(listener));

    try {
      expect(interrupt).toBeDefined();
      interrupt?.('SIGINT');
      expect(child.kill).toHaveBeenCalledWith('SIGINT');

      await vi.advanceTimersByTimeAsync(5_000);
      expect(child.kill.mock.calls).toEqual([['SIGINT'], ['SIGKILL']]);

      child.emit('exit', null, 'SIGKILL');
      await expect(controller.exit).resolves.toEqual({
        code: null,
        signal: 'SIGKILL',
      });
    } finally {
      child.emit('exit', null, 'SIGKILL');
      vi.useRealTimers();
    }
  });

  it('force-kills a server that does not stop gracefully', async () => {
    let resolve: (exit: AttachedServerExit) => void = () => undefined;
    const exit = new Promise<AttachedServerExit>((done) => {
      resolve = done;
    });
    const stop = vi.fn<(signal?: NodeJS.Signals) => void>((signal) => {
      if (signal === 'SIGKILL') resolve({ code: null, signal });
    });

    await stopAttachedServer({ exit, stop }, 1);

    expect(stop.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
  });
});

function serviceStatus(overrides: Partial<ServiceStatus> = {}): ServiceStatus {
  return {
    platform: 'linux',
    supported: true,
    installed: false,
    running: false,
    unitPath: '/tmp/neondeck.service',
    logPath: '/tmp/neondeck.log',
    port: 3583,
    health: { ok: false, url: 'http://127.0.0.1:3583/api/health' },
    warnings: [],
    ...overrides,
  };
}

function healthAfterFirstFailure(onCall: () => void): typeof fetch {
  let calls = 0;
  return (async () => {
    onCall();
    calls += 1;
    return new Response(null, { status: calls === 1 ? 503 : 200 });
  }) as typeof fetch;
}

function deferredServer(options: { resolveWhenStopped?: boolean } = {}) {
  let resolve: (exit: AttachedServerExit) => void = () => undefined;
  const exit = new Promise<AttachedServerExit>((done) => {
    resolve = done;
  });
  const stop = vi.fn<(signal?: NodeJS.Signals) => void>(
    (signal: NodeJS.Signals = 'SIGTERM') => {
      if (options.resolveWhenStopped) resolve({ code: null, signal });
    },
  );
  return { controller: { exit, stop }, resolve, stop };
}

it('uses bracketed IPv6 for dashboard probes and browser launch', async () => {
  vi.stubEnv('NEONDECK_PRIVATE_HOST', '::1');
  try {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ ok: true }),
    );
    const browser = vi.fn(async () => {});
    const launch = await openDashboard(
      { paths: runtimePaths('/tmp/synthetic-open-ipv6'), port: 3599 },
      {
        fetch: fetchImpl,
        spawn: browser,
        platform: 'linux',
        readProfiles: async () => ({}),
        readServiceStatus: async () => serviceStatus(),
      },
    );
    expect(launch.result.url).toBe('http://[::1]:3599');
    expect(
      fetchImpl.mock.calls.every(
        ([url]) => String(url) === 'http://[::1]:3599/api/health',
      ),
    ).toBe(true);
    expect(browser).toHaveBeenCalledWith('xdg-open', ['http://[::1]:3599'], {
      detached: true,
    });
  } finally {
    vi.unstubAllEnvs();
  }
});
