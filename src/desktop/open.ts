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
    startedBy: 'already-running' | 'service' | 'detached-serve' | 'none';
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

type CommandSpawner = (
  command: string,
  args: string[],
  options?: { detached?: boolean; env?: NodeJS.ProcessEnv; cwd?: string },
) => Promise<void>;

type OpenDependencies = {
  fetch?: typeof fetch;
  exists?: (path: string) => boolean;
  platform?: NodeJS.Platform;
  spawn?: CommandSpawner;
};

export async function openDashboard(
  options: OpenDashboardOptions,
  deps: OpenDependencies = {},
): Promise<OpenDashboardResult> {
  const serviceStatus = await readServiceStatus(options.paths);
  const port = resolveOpenPort(options.port, serviceStatus, options.paths.home);
  const url = `http://127.0.0.1:${port}`;
  const warnings: string[] = [];
  const profiles = await readWindowProfiles(options.paths);
  let geometry: WindowProfile;
  try {
    geometry = resolveWindowProfile(
      profiles,
      options.profile,
      options.overrides,
    );
  } catch (error) {
    return {
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
    };
  }
  const browser = resolveExplicitChromiumBrowser(
    options.browserPath,
    deps.exists,
  );

  if (options.browserPath && !browser) {
    return {
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
    };
  }

  const initialHealth = await probeHealth(url, deps.fetch);
  if (
    initialHealth.ok &&
    serviceRuntimeHomeMismatch(serviceStatus, options.paths.home) &&
    serviceStatus.port === port
  ) {
    return {
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
    };
  }

  let startedBy: OpenDashboardResult['server']['startedBy'] = initialHealth.ok
    ? 'already-running'
    : 'none';

  if (!initialHealth.ok) {
    const started = await startServerForOpen(
      options.paths,
      port,
      serviceStatus,
      options.paths.home,
      deps.spawn,
    );
    startedBy = started.startedBy;
    if (!started.ok) {
      return {
        ok: false,
        action: 'dashboard_open',
        changed: false,
        message: started.message,
        url,
        server: { wasRunning: false, startedBy },
        browser: { strategy: 'default-browser', geometryApplied: false },
        warnings,
        errors: started.errors,
      };
    }
    warnings.push(...started.warnings);
  }

  const ready = await waitForHealth(url, { fetch: deps.fetch });
  if (!ready.ok) {
    return {
      ok: false,
      action: 'dashboard_open',
      changed: false,
      message: `Neondeck server did not become ready at ${url}.`,
      url,
      server: { wasRunning: initialHealth.ok, startedBy },
      browser: { strategy: 'default-browser', geometryApplied: false },
      warnings,
      errors: [ready.error ?? `HTTP ${ready.status ?? 'unknown'}`],
    };
  }

  if (browser) {
    try {
      await launchChromiumApp(browser.path, url, geometry, deps.spawn);
    } catch (error) {
      return openLaunchFailure(url, initialHealth.ok, startedBy, {
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
      });
    }
    return {
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
    };
  }

  try {
    await openDefaultBrowser(url, deps.platform, deps.spawn);
  } catch (error) {
    return openLaunchFailure(url, initialHealth.ok, startedBy, {
      profile: options.profile,
      geometry,
      warnings,
      error,
      browser: { strategy: 'default-browser', geometryApplied: false },
    });
  }
  if (hasGeometry(geometry)) {
    warnings.push(
      'Window geometry and kiosk settings were not applied because the default browser was used. Pass --browser <path> to launch a Chromium app-mode window, or install the PWA to keep dedicated window bounds.',
    );
  }
  return {
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
  };
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
  } = {},
) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  let last = await probeHealth(url, options.fetch);
  while (!last.ok && Date.now() < deadline) {
    await sleep(intervalMs);
    last = await probeHealth(url, options.fetch);
  }
  return last;
}

async function startServerForOpen(
  paths: RuntimePaths,
  port: number,
  serviceStatus: ServiceStatus,
  runtimeHome: string,
  spawnCommand?: CommandSpawner,
) {
  try {
    if (
      serviceMatchesRuntimeHome(serviceStatus, runtimeHome) &&
      serviceStatus.port === port
    ) {
      const result = await startService(paths);
      return {
        ok: result.ok,
        startedBy: 'service' as const,
        message: result.message,
        warnings: statusWarnings(result.status),
        errors: result.errors,
      };
    }

    await spawnDetachedServe(paths, port, spawnCommand);
    const warnings = [...statusWarnings(serviceStatus)];
    if (serviceRuntimeHomeMismatch(serviceStatus, runtimeHome)) {
      warnings.push(serviceRuntimeHomeWarning(serviceStatus, runtimeHome));
    } else if (serviceStatus.installed && serviceStatus.port !== port) {
      warnings.push(
        `Installed service is configured for port ${serviceStatus.port}; started detached serve for requested port ${port}.`,
      );
    } else {
      warnings.push(
        'Neondeck service is not installed; started a detached server for this login session.',
      );
    }
    return {
      ok: true,
      startedBy: 'detached-serve' as const,
      message:
        'Started Neondeck with a detached foreground server. Run neondeck service install for login startup.',
      warnings,
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

async function spawnDetachedServe(
  paths: RuntimePaths,
  port: number,
  spawnCommand: CommandSpawner = spawnDetached,
) {
  const entry = resolvePackagedServerEntry();
  if (!existsSync(entry)) {
    throw new Error(
      `Built Neondeck server entry was not found at ${entry}. Run npm run build:server or install a packaged Neondeck build before using neondeck open without an installed service.`,
    );
  }
  const args = [entry];
  await spawnCommand(process.execPath, args, {
    detached: true,
    cwd: packageRootForServerEntry(entry),
    env: {
      ...process.env,
      NEONDECK_HOME: paths.home,
      NEONDECK_PORT: String(port),
      PORT: String(port),
    },
  });
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

async function probeHealth(url: string, fetchImpl: typeof fetch = fetch) {
  const healthUrl = `${url.replace(/\/$/, '')}/api/health`;
  const controller = new AbortController();
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
  const result: WindowProfile = {};
  if (profile.width !== undefined) result.width = profile.width;
  if (profile.height !== undefined) result.height = profile.height;
  if (profile.x !== undefined) result.x = profile.x;
  if (profile.y !== undefined) result.y = profile.y;
  if (profile.kiosk !== undefined) result.kiosk = profile.kiosk;
  return result;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
