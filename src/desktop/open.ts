import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseDashboardConfig,
  readRuntimeJson,
  type DashboardWindowProfile,
  type RuntimePaths,
} from '../runtime-home';
import { defaultServerPort, resolveServerPort } from '../server/serve';
import { readServiceStatus, startService, type ServiceStatus } from './service';

export type WindowProfile = DashboardWindowProfile;

export type WindowProfileOverrides = {
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  kiosk?: boolean;
};

export type BrowserCandidate = {
  id: string;
  name: string;
  paths: string[];
  executableNames: string[];
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
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawn?: CommandSpawner;
};

export async function openDashboard(
  options: OpenDashboardOptions,
  deps: OpenDependencies = {},
): Promise<OpenDashboardResult> {
  const serviceStatus = await readServiceStatus(options.paths);
  const port = resolveOpenPort(options.port, serviceStatus);
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
  const browser = findChromiumBrowser({
    platform: deps.platform,
    env: deps.env,
    exists: deps.exists,
    explicitPath: options.browserPath,
  });

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
  let startedBy: OpenDashboardResult['server']['startedBy'] = initialHealth.ok
    ? 'already-running'
    : 'none';

  if (!initialHealth.ok) {
    const started = await startServerForOpen(
      options.paths,
      port,
      serviceStatus,
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
  warnings.push(
    'No Chromium-family browser was found, so geometry flags were not applied. Install the PWA to keep dedicated window bounds.',
  );
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

export function chromiumCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): BrowserCandidate[] {
  const home = env.HOME;
  if (platform === 'darwin') {
    const appRoots = ['/Applications'];
    if (home) appRoots.push(join(home, 'Applications'));
    return [
      macApp('chrome', 'Google Chrome', 'Google Chrome.app', appRoots),
      macApp('edge', 'Microsoft Edge', 'Microsoft Edge.app', appRoots),
      macApp('brave', 'Brave Browser', 'Brave Browser.app', appRoots),
      macApp('chromium', 'Chromium', 'Chromium.app', appRoots),
    ];
  }

  if (platform === 'win32') {
    const roots = [
      env.LOCALAPPDATA,
      env.PROGRAMFILES,
      env['PROGRAMFILES(X86)'],
    ].filter((value): value is string => Boolean(value));
    return [
      windowsApp('chrome', 'Google Chrome', roots, [
        ['Google', 'Chrome', 'Application', 'chrome.exe'],
      ]),
      windowsApp('edge', 'Microsoft Edge', roots, [
        ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
      ]),
      windowsApp('brave', 'Brave Browser', roots, [
        ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
      ]),
    ];
  }

  return [
    linuxApp('chrome', 'Google Chrome', 'google-chrome'),
    linuxApp('edge', 'Microsoft Edge', 'microsoft-edge'),
    linuxApp('brave', 'Brave Browser', 'brave-browser'),
    linuxApp('chromium', 'Chromium', 'chromium'),
    linuxApp('chromium-browser', 'Chromium', 'chromium-browser'),
  ];
}

export function findChromiumBrowser(
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    exists?: (path: string) => boolean;
    explicitPath?: string;
  } = {},
): BrowserMatch | null {
  const exists = options.exists ?? existsSync;
  if (options.explicitPath) {
    return exists(options.explicitPath)
      ? { id: 'custom', name: 'Custom Chromium', path: options.explicitPath }
      : null;
  }

  const env = options.env ?? process.env;
  for (const candidate of chromiumCandidates(options.platform, env)) {
    for (const path of candidate.paths) {
      if (exists(path)) {
        return { id: candidate.id, name: candidate.name, path };
      }
    }
    for (const executable of candidate.executableNames) {
      const found = findOnPath(executable, env, exists);
      if (found) return { id: candidate.id, name: candidate.name, path: found };
    }
  }
  return null;
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
  spawnCommand?: CommandSpawner,
) {
  try {
    if (serviceStatus.installed && serviceStatus.port === port) {
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
    const warnings =
      serviceStatus.installed && serviceStatus.port !== port
        ? [
            `Installed service is configured for port ${serviceStatus.port}; started detached serve for requested port ${port}.`,
          ]
        : [
            'Neondeck service is not installed; started a detached server for this login session.',
          ];
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
  const entry = fileURLToPath(new URL('../cli/index.ts', import.meta.url));
  const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
  const args = [
    '--import',
    resolveTsxImportSpecifier(),
    entry,
    'serve',
    '--port',
    String(port),
  ];
  await spawnCommand(process.execPath, args, {
    detached: true,
    cwd: packageRoot,
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

function resolveOpenPort(
  value: number | string | undefined,
  serviceStatus: ServiceStatus,
) {
  if (
    value === undefined &&
    process.env.NEONDECK_PORT === undefined &&
    process.env.PORT === undefined &&
    serviceStatus.installed
  ) {
    return serviceStatus.port;
  }

  return resolveServerPort(value);
}

function resolveTsxImportSpecifier() {
  try {
    return import.meta.resolve('tsx');
  } catch {
    return 'tsx';
  }
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

function macApp(
  id: string,
  name: string,
  appName: string,
  roots: string[],
): BrowserCandidate {
  return {
    id,
    name,
    paths: roots.map((root) =>
      join(root, appName, 'Contents', 'MacOS', appName.replace(/\.app$/, '')),
    ),
    executableNames: [],
  };
}

function windowsApp(
  id: string,
  name: string,
  roots: string[],
  relativePaths: string[][],
): BrowserCandidate {
  return {
    id,
    name,
    paths: roots.flatMap((root) =>
      relativePaths.map((path) => join(root, ...path)),
    ),
    executableNames: [],
  };
}

function linuxApp(
  id: string,
  name: string,
  executable: string,
): BrowserCandidate {
  return { id, name, paths: [], executableNames: [executable] };
}

function findOnPath(
  executable: string,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
) {
  for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(directory, executable);
    if (exists(candidate)) return candidate;
  }
  return null;
}

function stripUndefined(profile: WindowProfile): WindowProfile {
  return Object.fromEntries(
    Object.entries(profile).filter(([, value]) => value !== undefined),
  ) as WindowProfile;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
