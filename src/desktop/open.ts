import { privateServerUrl } from '../lib/server-address';
import { loadNeondeckEnv } from '../modules/runtime/env';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  parseDashboardConfig,
  readRuntimeJson,
  type DashboardWindowProfile,
  type RuntimePaths,
} from '../runtime-home';
import {
  packageRootForServerEntry,
  resolvePackagedServerEntry,
  resolveServerPort,
  serverSignalExitCode,
} from '../server/serve';
import { readServiceStatus, startService, type ServiceStatus } from './service';

export type WindowProfile = DashboardWindowProfile;

export type WindowProfileOverrides = {
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  kiosk?: boolean;
};

export type BrowserMatch = {
  id: string;
  name: string;
  path: string;
};

export type OpenDashboardOptions = {
  paths: RuntimePaths;
  profile?: string;
  port?: number | string;
  browserPath?: string;
  overrides?: WindowProfileOverrides;
  suppressServerOutput?: boolean;
};

export type OpenDashboardResult = {
  ok: boolean;
  action: 'dashboard_open';
  changed: boolean;
  message: string;
  url: string;
  profile?: string;
  geometry?: WindowProfile;
  server: {
    wasRunning: boolean;
    startedBy: 'already-running' | 'service' | 'attached-serve' | 'none';
  };
  browser: {
    strategy: 'chromium-app' | 'default-browser';
    name?: string;
    path?: string;
    geometryApplied: boolean;
  };
  warnings?: string[];
  errors?: string[];
};

export type AttachedServerExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
};

export type AttachedServerController = {
  exit: Promise<AttachedServerExit>;
  stop: (signal?: NodeJS.Signals) => void;
};

export type OpenDashboardLaunch = {
  result: OpenDashboardResult;
  serverExit?: Promise<AttachedServerExit>;
};

type HealthResult = {
  ok: boolean;
  status?: number;
  error?: string;
  serverExited?: boolean;
  serverExit?: AttachedServerExit;
};

type CommandSpawner = (
  command: string,
  args: string[],
  options?: { detached?: boolean; env?: NodeJS.ProcessEnv; cwd?: string },
) => Promise<void>;

type AttachedServerSpawner = (
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    cwd: string;
    suppressOutput?: boolean;
  },
) => AttachedServerController;

type ControllableChild = {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: (signal?: NodeJS.Signals) => boolean;
  once: {
    (event: 'error', listener: (error: Error) => void): unknown;
    (
      event: 'exit',
      listener: (code: number | null, signal: NodeJS.Signals | null) => void,
    ): unknown;
  };
};

type OpenDependencies = {
  fetch?: typeof fetch;
  exists?: (path: string) => boolean;
  platform?: NodeJS.Platform;
  spawn?: CommandSpawner;
  spawnServer?: AttachedServerSpawner;
  readProfiles?: typeof readWindowProfiles;
  readServiceStatus?: typeof readServiceStatus;
  startService?: typeof startService;
};

export async function openDashboard(
  options: OpenDashboardOptions,
  deps: OpenDependencies = {},
): Promise<OpenDashboardLaunch> {
  loadNeondeckEnv(options.paths, { includeDevFallback: false });
  const serviceStatus = await (deps.readServiceStatus ?? readServiceStatus)(
    options.paths,
  );
  const port = resolveOpenPort(options.port, serviceStatus, options.paths.home);
  const url = privateServerUrl(port);
  const warnings: string[] = [];
  const profiles = await (deps.readProfiles ?? readWindowProfiles)(
    options.paths,
  );
  let geometry: WindowProfile;
  try {
    geometry = resolveWindowProfile(
      profiles,
      options.profile,
      options.overrides,
    );
  } catch (error) {
    return launchResult({
      ok: false,
      action: 'dashboard_open',
      changed: false,
      message: 'Could not resolve Neondeck window profile.',
      url,
      profile: options.profile,
      server: { wasRunning: false, startedBy: 'none' },
      browser: { strategy: 'default-browser', geometryApplied: false },
      warnings,
      errors: [error instanceof Error ? error.message : String(error)],
    });
  }
  const browser = resolveExplicitChromiumBrowser(
    options.browserPath,
    deps.exists,
  );

  if (options.browserPath && !browser) {
    return launchResult({
      ok: false,
      action: 'dashboard_open',
      changed: false,
      message: `Chromium browser was not found at ${options.browserPath}.`,
      url,
      profile: options.profile,
      geometry,
      server: { wasRunning: false, startedBy: 'none' },
      browser: { strategy: 'default-browser', geometryApplied: false },
      warnings,
      errors: [`Browser path does not exist: ${options.browserPath}`],
    });
  }

  const initialHealth = await probeHealth(url, deps.fetch);
  if (
    initialHealth.ok &&
    serviceRuntimeHomeMismatch(serviceStatus, options.paths.home) &&
    serviceStatus.port === port
  ) {
    return launchResult({
      ok: false,
      action: 'dashboard_open',
      changed: false,
      message:
        'Refusing to open a Neondeck service installed for another runtime home.',
      url,
      profile: options.profile,
      geometry,
      server: { wasRunning: true, startedBy: 'none' },
      browser: { strategy: 'default-browser', geometryApplied: false },
      warnings: [
        ...warnings,
        ...statusWarnings(serviceStatus),
        serviceRuntimeHomeWarning(serviceStatus, options.paths.home),
      ],
      errors: [
        `Service at ${url} is configured for ${serviceStatus.runtimeHome ?? 'an unknown runtime home'}, not ${options.paths.home}. Use a different --port, stop that service, or reinstall it for this runtime home.`,
      ],
    });
  }

  let startedBy: OpenDashboardResult['server']['startedBy'] = initialHealth.ok
    ? 'already-running'
    : 'none';
  let attachedServer: AttachedServerController | undefined;

  if (!initialHealth.ok) {
    const started = await startServerForOpen(
      options.paths,
      port,
      serviceStatus,
      options.paths.home,
      deps,
      options.suppressServerOutput,
    );
    startedBy = started.startedBy;
    attachedServer = started.attachedServer;
    if (!started.ok) {
      return launchResult({
        ok: false,
        action: 'dashboard_open',
        changed: false,
        message: started.message,
        url,
        server: { wasRunning: false, startedBy },
        browser: { strategy: 'default-browser', geometryApplied: false },
        warnings,
        errors: started.errors,
      });
    }
    warnings.push(...started.warnings);
  }

  const ready = attachedServer
    ? await waitForAttachedServerHealth(url, attachedServer, deps.fetch)
    : await waitForHealth(url, { fetch: deps.fetch });
  if (!ready.ok) {
    if (attachedServer && ready.serverExited !== true) {
      await stopAttachedServer(attachedServer);
    }
    return launchResult({
      ok: false,
      action: 'dashboard_open',
      changed: false,
      message: `Neondeck server did not become ready at ${url}.`,
      url,
      server: { wasRunning: initialHealth.ok, startedBy },
      browser: { strategy: 'default-browser', geometryApplied: false },
      warnings,
      errors: [
        ready.serverExit?.error ??
          ready.error ??
          (ready.serverExit
            ? `Server exited before becoming ready (${formatAttachedServerExitDetails(ready.serverExit)}).`
            : `HTTP ${ready.status ?? 'unknown'}`),
      ],
    });
  }

  if (browser) {
    try {
      await launchChromiumApp(browser.path, url, geometry, deps.spawn);
    } catch (error) {
      if (attachedServer) await stopAttachedServer(attachedServer);
      return launchResult(
        openLaunchFailure(url, initialHealth.ok, startedBy, {
          profile: options.profile,
          geometry,
          warnings,
          error,
          browser: {
            strategy: 'chromium-app',
            name: browser.name,
            path: browser.path,
            geometryApplied: hasGeometry(geometry),
          },
        }),
      );
    }
    return launchResult(
      {
        ok: true,
        action: 'dashboard_open',
        changed: true,
        message: `Opened Neondeck in ${browser.name}.`,
        url,
        profile: options.profile,
        geometry,
        server: { wasRunning: initialHealth.ok, startedBy },
        browser: {
          strategy: 'chromium-app',
          name: browser.name,
          path: browser.path,
          geometryApplied: hasGeometry(geometry),
        },
        warnings: warnings.length ? warnings : undefined,
      },
      attachedServer,
    );
  }

  try {
    await openDefaultBrowser(url, deps.platform, deps.spawn);
  } catch (error) {
    if (attachedServer) await stopAttachedServer(attachedServer);
    return launchResult(
      openLaunchFailure(url, initialHealth.ok, startedBy, {
        profile: options.profile,
        geometry,
        warnings,
        error,
        browser: { strategy: 'default-browser', geometryApplied: false },
      }),
    );
  }
  if (hasGeometry(geometry)) {
    warnings.push(
      'Window geometry and kiosk settings were not applied because the default browser was used. Pass --browser <path> to launch a Chromium app-mode window, or install the PWA to keep dedicated window bounds.',
    );
  }
  return launchResult(
    {
      ok: true,
      action: 'dashboard_open',
      changed: true,
      message: 'Opened Neondeck in the default browser.',
      url,
      profile: options.profile,
      geometry,
      server: { wasRunning: initialHealth.ok, startedBy },
      browser: { strategy: 'default-browser', geometryApplied: false },
      warnings,
    },
    attachedServer,
  );
}

export async function readWindowProfiles(paths: RuntimePaths) {
  const config = await readRuntimeJson(paths.dashboard, parseDashboardConfig);
  return config.windows ?? {};
}

export function resolveWindowProfile(
  profiles: Record<string, WindowProfile>,
  profileName: string | undefined,
  overrides: WindowProfileOverrides = {},
): WindowProfile {
  const profile = profileName ? profiles[profileName] : {};
  if (profileName && !profile) {
    const available = Object.keys(profiles).sort().join(', ') || 'none';
    throw new Error(
      `Unknown window profile "${profileName}". Available: ${available}.`,
    );
  }

  const resolved = stripUndefined({
    ...profile,
    ...overrides,
  });
  validateWindowProfile(resolved);
  return resolved;
}

export function resolveExplicitChromiumBrowser(
  explicitPath: string | undefined,
  exists: (path: string) => boolean = existsSync,
): BrowserMatch | null {
  if (!explicitPath || !exists(explicitPath)) return null;
  return { id: 'custom', name: 'Custom Chromium', path: explicitPath };
}

export async function waitForHealth(
  url: string,
  options: {
    fetch?: typeof fetch;
    timeoutMs?: number;
    intervalMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<HealthResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  let last = await probeHealth(url, options.fetch, options.signal);
  while (!last.ok && !options.signal?.aborted && Date.now() < deadline) {
    await sleep(intervalMs, options.signal);
    if (!options.signal?.aborted) {
      last = await probeHealth(url, options.fetch, options.signal);
    }
  }
  return last;
}

async function startServerForOpen(
  paths: RuntimePaths,
  port: number,
  serviceStatus: ServiceStatus,
  runtimeHome: string,
  deps: OpenDependencies,
  suppressServerOutput = false,
) {
  try {
    if (
      serviceMatchesRuntimeHome(serviceStatus, runtimeHome) &&
      serviceStatus.port === port
    ) {
      const result = await (deps.startService ?? startService)(paths);
      return {
        ok: result.ok,
        startedBy: 'service' as const,
        message: result.message,
        warnings: statusWarnings(result.status),
        errors: result.errors,
      };
    }

    const attachedServer = spawnAttachedServe(
      paths,
      port,
      deps.spawnServer,
      deps.exists,
      suppressServerOutput,
    );
    const warnings = [...statusWarnings(serviceStatus)];
    if (serviceRuntimeHomeMismatch(serviceStatus, runtimeHome)) {
      warnings.push(serviceRuntimeHomeWarning(serviceStatus, runtimeHome));
    } else if (serviceStatus.installed && serviceStatus.port !== port) {
      warnings.push(
        `Installed service is configured for port ${serviceStatus.port}; the server for requested port ${port} is attached to this terminal.`,
      );
    }
    return {
      ok: true,
      startedBy: 'attached-serve' as const,
      message: 'Started Neondeck server attached to this terminal.',
      warnings,
      attachedServer,
    };
  } catch (error) {
    return {
      ok: false,
      startedBy: 'none' as const,
      message: 'Could not start Neondeck server.',
      warnings: [],
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

async function launchChromiumApp(
  browserPath: string,
  url: string,
  geometry: WindowProfile,
  spawnCommand: CommandSpawner = spawnDetached,
) {
  const args = [`--app=${url}`];
  if (geometry.width && geometry.height) {
    args.push(`--window-size=${geometry.width},${geometry.height}`);
  }
  if (geometry.x !== undefined && geometry.y !== undefined) {
    args.push(`--window-position=${geometry.x},${geometry.y}`);
  }
  if (geometry.kiosk) args.push('--kiosk');
  await spawnCommand(browserPath, args, { detached: true });
}

async function openDefaultBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
  spawnCommand: CommandSpawner = spawnDetached,
) {
  if (platform === 'darwin') {
    await spawnCommand('open', [url], { detached: true });
    return;
  }
  if (platform === 'win32') {
    await spawnCommand('cmd', ['/c', 'start', '', url], { detached: true });
    return;
  }
  await spawnCommand('xdg-open', [url], { detached: true });
}

function spawnAttachedServe(
  paths: RuntimePaths,
  port: number,
  spawnServer: AttachedServerSpawner = spawnAttached,
  exists: (path: string) => boolean = existsSync,
  suppressOutput = false,
) {
  const entry = resolvePackagedServerEntry();
  if (!exists(entry)) {
    throw new Error(
      `Built Neondeck server entry was not found at ${entry}. Run npm run build:server or install a packaged Neondeck build before using neondeck open without an installed service.`,
    );
  }
  const args = [entry];
  return spawnServer(process.execPath, args, {
    cwd: packageRootForServerEntry(entry),
    suppressOutput,
    env: {
      ...process.env,
      NEONDECK_HOME: paths.home,
      NEONDECK_PORT: String(port),
      PORT: String(port),
    },
  });
}

function spawnAttached(
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    cwd: string;
    suppressOutput?: boolean;
  },
): AttachedServerController {
  const child = spawn(command, args, {
    detached: false,
    cwd: options.cwd,
    env: options.env,
    // Keep JSON stdout parseable while preserving diagnostics on stderr.
    stdio: options.suppressOutput
      ? ['inherit', 'ignore', 'inherit']
      : 'inherit',
  });
  return controlAttachedServer(child);
}

export function controlAttachedServer(
  child: ControllableChild,
): AttachedServerController {
  let settled = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveExit: (exit: AttachedServerExit) => void = () => undefined;
  const exit = new Promise<AttachedServerExit>((resolve) => {
    resolveExit = resolve;
  });
  const stop = (signal: NodeJS.Signals = 'SIGTERM') => {
    if (settled || child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill(signal);
    } catch (error) {
      // A child can exit between the state check and kill(). Its exit event will
      // settle the controller, so do not turn that normal race into a failure.
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        finish({
          code: null,
          signal: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
  const armForceKill = () => {
    if (settled || forceKillTimer) return;
    forceKillTimer = setTimeout(() => {
      forceKillTimer = undefined;
      stop('SIGKILL');
    }, 5_000);
  };
  const forwardSigint = () => {
    stop('SIGINT');
    armForceKill();
  };
  const forwardSigterm = () => {
    stop('SIGTERM');
    armForceKill();
  };
  const finish = (result: AttachedServerExit) => {
    if (settled) return;
    settled = true;
    if (forceKillTimer) clearTimeout(forceKillTimer);
    process.off('SIGINT', forwardSigint);
    process.off('SIGTERM', forwardSigterm);
    resolveExit(result);
  };

  process.on('SIGINT', forwardSigint);
  process.on('SIGTERM', forwardSigterm);
  child.once('error', (error) => {
    finish({
      code: null,
      signal: null,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  child.once('exit', (code, signal) => finish({ code, signal }));

  return { exit, stop };
}

async function spawnDetached(
  command: string,
  args: string[],
  options: { detached?: boolean; env?: NodeJS.ProcessEnv; cwd?: string } = {},
) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: options.detached ?? true,
      cwd: options.cwd,
      env: options.env,
      stdio: 'ignore',
    });
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };
    child.once('error', (error) => finish(() => reject(error)));
    setTimeout(() => {
      child.unref();
      finish(resolve);
    }, 50);
  });
}

async function waitForAttachedServerHealth(
  url: string,
  server: AttachedServerController,
  fetchImpl?: typeof fetch,
): Promise<HealthResult> {
  const controller = new AbortController();
  const healthPromise = waitForHealth(url, {
    fetch: fetchImpl,
    signal: controller.signal,
  });
  const outcome = await Promise.race([
    healthPromise.then((health) => ({ kind: 'health' as const, health })),
    server.exit.then((serverExit) => ({
      kind: 'server-exit' as const,
      serverExit,
    })),
  ]);
  if (outcome.kind === 'health') return outcome.health;

  controller.abort();
  await healthPromise;
  return {
    ok: false,
    serverExited: true,
    serverExit: outcome.serverExit,
  };
}

export async function stopAttachedServer(
  server: AttachedServerController,
  timeoutMs = 5_000,
) {
  server.stop('SIGTERM');
  if (await waitForAttachedServerExit(server.exit, timeoutMs)) return;
  server.stop('SIGKILL');
  await server.exit;
}

async function waitForAttachedServerExit(
  exit: Promise<AttachedServerExit>,
  timeoutMs: number,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exit.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function launchResult(
  result: OpenDashboardResult,
  attachedServer?: AttachedServerController,
): OpenDashboardLaunch {
  return {
    result,
    ...(attachedServer ? { serverExit: attachedServer.exit } : {}),
  };
}

export function openServerExitCode(exit: AttachedServerExit) {
  if (exit.error) return 1;
  if (exit.signal) return serverSignalExitCode(exit.signal);
  return exit.code ?? 0;
}

export function formatOpenServerExit(exit: AttachedServerExit) {
  if (exit.error) return `Neondeck server failed: ${exit.error}`;
  if (openServerStoppedCleanly(exit)) {
    return 'Neondeck stopped.';
  }
  if (exit.signal) {
    return `Neondeck server stopped after ${exit.signal}.`;
  }
  return exit.code === 0
    ? 'Neondeck stopped.'
    : `Neondeck server stopped unexpectedly with code ${exit.code ?? 'unknown'}.`;
}

export function openServerStoppedCleanly(exit: AttachedServerExit) {
  return (
    !exit.error &&
    (exit.signal === 'SIGINT' ||
      exit.signal === 'SIGTERM' ||
      exit.code === 0 ||
      exit.code === 130 ||
      exit.code === 143)
  );
}

function formatAttachedServerExitDetails(exit: AttachedServerExit) {
  if (exit.error) return exit.error;
  if (exit.signal) return `signal ${exit.signal}`;
  return `code ${exit.code ?? 'unknown'}`;
}

async function probeHealth(
  url: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<HealthResult> {
  const healthUrl = `${url.replace(/\/$/, '')}/api/health`;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), 750);
  try {
    const response = await fetchImpl(healthUrl, { signal: controller.signal });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

function statusWarnings(status: ServiceStatus | undefined) {
  return status?.warnings ?? [];
}

export function resolveOpenPort(
  value: number | string | undefined,
  serviceStatus: ServiceStatus,
  runtimeHome: string,
) {
  if (
    value === undefined &&
    process.env.NEONDECK_PORT === undefined &&
    process.env.PORT === undefined &&
    serviceMatchesRuntimeHome(serviceStatus, runtimeHome)
  ) {
    return serviceStatus.port;
  }

  return resolveServerPort(value);
}

export function serviceMatchesRuntimeHome(
  serviceStatus: ServiceStatus,
  runtimeHome: string,
) {
  return serviceStatus.installed && serviceStatus.runtimeHome === runtimeHome;
}

function serviceRuntimeHomeMismatch(
  serviceStatus: ServiceStatus,
  runtimeHome: string,
) {
  return (
    serviceStatus.installed &&
    !serviceMatchesRuntimeHome(serviceStatus, runtimeHome)
  );
}

function serviceRuntimeHomeWarning(
  serviceStatus: ServiceStatus,
  runtimeHome: string,
) {
  return `Installed service is configured for ${serviceStatus.runtimeHome ?? 'an unknown runtime home'}; using requested runtime home ${runtimeHome} instead.`;
}

function validateWindowProfile(profile: WindowProfile) {
  if ((profile.width === undefined) !== (profile.height === undefined)) {
    throw new Error('Window geometry must set width and height together.');
  }
  if ((profile.x === undefined) !== (profile.y === undefined)) {
    throw new Error('Window geometry must set x and y together.');
  }
}

function openLaunchFailure(
  url: string,
  wasRunning: boolean,
  startedBy: OpenDashboardResult['server']['startedBy'],
  options: {
    profile?: string;
    geometry: WindowProfile;
    warnings: string[];
    error: unknown;
    browser: OpenDashboardResult['browser'];
  },
): OpenDashboardResult {
  return {
    ok: false,
    action: 'dashboard_open',
    changed: false,
    message: 'Could not open Neondeck dashboard.',
    url,
    profile: options.profile,
    geometry: options.geometry,
    server: { wasRunning, startedBy },
    browser: options.browser,
    warnings: options.warnings,
    errors: [
      options.error instanceof Error
        ? options.error.message
        : String(options.error),
    ],
  };
}

function hasGeometry(profile: WindowProfile) {
  return Boolean(
    (profile.width && profile.height) ||
    (profile.x !== undefined && profile.y !== undefined) ||
    profile.kiosk,
  );
}

function stripUndefined(profile: WindowProfile): WindowProfile {
  return Object.fromEntries(
    Object.entries(profile).filter(([, value]) => value !== undefined),
  ) as WindowProfile;
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    const abort = () => finish();
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) finish();
  });
}
