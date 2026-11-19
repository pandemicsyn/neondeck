import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { runExecFile, type ExecFileOutput } from '../lib/exec';
import {
  defaultServerPort,
  packageRootForServerEntry,
  resolvePackagedServerEntry,
  resolveServerPort,
} from '../server/serve';
import type { RuntimePaths } from '../runtime-home';

export const launchdLabel = 'dev.neondeck.server';
export const systemdUnitName = 'neondeck.service';

export type ServicePlatform = NodeJS.Platform;

export type ServicePaths = {
  platform: ServicePlatform;
  unitPath: string;
  logPath: string;
};

export type ServiceDefinitionOptions = {
  nodePath: string;
  serverEntry: string;
  runtimeHome: string;
  logPath: string;
  port: number;
  workingDirectory?: string;
};

export type ServiceInstallOptions = {
  paths: RuntimePaths;
  port?: number | string;
  platform?: ServicePlatform;
  homeDirectory?: string;
  uid?: number;
  nodePath?: string;
  serverEntry?: string;
  workingDirectory?: string;
};

export type ServiceCommandResult = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  status?: ServiceStatus;
  files?: string[];
  errors?: string[];
};

export type ServiceHealth = {
  ok: boolean;
  url: string;
  status?: number;
  error?: string;
};

export type ServiceStatus = {
  platform: ServicePlatform;
  supported: boolean;
  installed: boolean;
  running: boolean;
  pid?: number;
  unitPath: string;
  logPath: string;
  port: number;
  health: ServiceHealth;
  nodePath?: string;
  nodePathExists?: boolean;
  serverEntry?: string;
  serverEntryExists?: boolean;
  runtimeHome?: string;
  warnings: string[];
};

type InstalledServiceConfig = {
  nodePath?: string;
  serverEntry?: string;
  runtimeHome?: string;
  port?: string;
  logPath?: string;
};

type CommandRunner = (file: string, args?: string[]) => Promise<ExecFileOutput>;

export function servicePaths(
  paths: RuntimePaths,
  options: {
    platform?: ServicePlatform;
    homeDirectory?: string;
    xdgConfigHome?: string;
  } = {},
): ServicePaths {
  const platform = options.platform ?? process.platform;
  const home = options.homeDirectory ?? homedir();
  const logPath = join(paths.data, 'logs', 'server.log');
  if (platform === 'darwin') {
    return {
      platform,
      unitPath: join(home, 'Library', 'LaunchAgents', `${launchdLabel}.plist`),
      logPath,
    };
  }

  const configHome =
    options.xdgConfigHome ||
    process.env.XDG_CONFIG_HOME ||
    join(home, '.config');
  return {
    platform,
    unitPath: join(configHome, 'systemd', 'user', systemdUnitName),
    logPath,
  };
}

export function renderLaunchdPlist(options: ServiceDefinitionOptions) {
  const env = {
    NEONDECK_HOME: options.runtimeHome,
    NEONDECK_PORT: String(options.port),
    PORT: String(options.port),
  };

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(launchdLabel)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(options.nodePath)}</string>
    <string>${escapeXml(options.serverEntry)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env)
  .map(
    ([key, value]) =>
      `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`,
  )
  .join('\n')}
  </dict>
  ${
    options.workingDirectory
      ? `<key>WorkingDirectory</key>\n  <string>${escapeXml(options.workingDirectory)}</string>\n  `
      : ''
  }<key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(options.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(options.logPath)}</string>
</dict>
</plist>
`;
}

export function renderSystemdUnit(options: ServiceDefinitionOptions) {
  const environment = [
    ['NEONDECK_HOME', options.runtimeHome],
    ['NEONDECK_PORT', String(options.port)],
    ['PORT', String(options.port)],
  ] as const;

  return `[Unit]
Description=Neondeck local server
After=network.target

[Service]
Type=simple
ExecStart=${systemdQuote(options.nodePath)} ${systemdQuote(options.serverEntry)}
Restart=on-failure
${options.workingDirectory ? `WorkingDirectory=${systemdQuote(options.workingDirectory)}\n` : ''}${environment
    .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`)
    .join('\n')}
StandardOutput=append:${options.logPath}
StandardError=append:${options.logPath}

[Install]
WantedBy=default.target
`;
}

export async function installService(
  options: ServiceInstallOptions,
): Promise<ServiceCommandResult> {
  const writtenFiles: string[] = [];
  try {
    const platform = options.platform ?? process.platform;
    if (!isSupportedServicePlatform(platform)) {
      return unsupportedResult('service_install', platform);
    }

    const definition = serviceDefinitionOptions(options);
    if (!existsSync(definition.serverEntry)) {
      return {
        ok: false,
        action: 'service_install',
        changed: false,
        message: `Built Neondeck server entry was not found at ${definition.serverEntry}. Run npm run build:server or reinstall the release archive.`,
        files: [definition.serverEntry],
      };
    }

    const locations = servicePaths(options.paths, {
      platform,
      homeDirectory: options.homeDirectory,
    });
    await mkdir(dirname(locations.unitPath), { recursive: true });
    await mkdir(dirname(locations.logPath), { recursive: true });
    writtenFiles.push(locations.logPath);

    const source =
      platform === 'darwin'
        ? renderLaunchdPlist(definition)
        : renderSystemdUnit(definition);
    await writeFile(locations.unitPath, source, 'utf8');
    writtenFiles.push(locations.unitPath);

    if (platform === 'darwin') {
      await bootoutLaunchd(locations.unitPath, options.uid);
      await runExecFile('launchctl', [
        'bootstrap',
        launchdDomain(options.uid),
        locations.unitPath,
      ]);
      await runExecFile('launchctl', [
        'kickstart',
        '-k',
        `${launchdDomain(options.uid)}/${launchdLabel}`,
      ]);
    } else {
      await runExecFile('systemctl', ['--user', 'daemon-reload']);
      await runExecFile('systemctl', [
        '--user',
        'enable',
        '--now',
        systemdUnitName,
      ]);
    }

    const status = await waitForServiceStatus(
      options.paths,
      {
        platform,
        homeDirectory: options.homeDirectory,
      },
      (item) => item.running && item.health.ok,
    );
    const ok = status.running && status.health.ok;
    return {
      ok,
      action: 'service_install',
      changed: true,
      message: ok
        ? `Installed Neondeck service at ${locations.unitPath}.`
        : `Installed Neondeck service at ${locations.unitPath}, but it is not healthy yet.`,
      status,
      files: [locations.unitPath, locations.logPath],
      errors: ok
        ? undefined
        : [serviceStateError(status, 'running and healthy')],
    };
  } catch (error) {
    return serviceCommandError(
      'service_install',
      error,
      writtenFiles.length > 0,
      writtenFiles,
    );
  }
}

export async function uninstallService(
  paths: RuntimePaths,
  options: {
    platform?: ServicePlatform;
    homeDirectory?: string;
    uid?: number;
  } = {},
): Promise<ServiceCommandResult> {
  let changed = false;
  let files: string[] = [];
  try {
    const platform = options.platform ?? process.platform;
    if (!isSupportedServicePlatform(platform)) {
      return unsupportedResult('service_uninstall', platform);
    }

    const locations = servicePaths(paths, {
      platform,
      homeDirectory: options.homeDirectory,
    });
    files = [locations.unitPath];
    const installed = existsSync(locations.unitPath);

    if (platform === 'darwin') {
      await bootoutLaunchd(locations.unitPath, options.uid);
    } else if (installed) {
      await runExecFile('systemctl', [
        '--user',
        'disable',
        '--now',
        systemdUnitName,
      ]);
    }

    await rm(locations.unitPath, { force: true });
    changed = installed;
    if (platform === 'linux' && installed) {
      await runExecFile('systemctl', ['--user', 'daemon-reload']);
    }

    return {
      ok: true,
      action: 'service_uninstall',
      changed,
      message: `Uninstalled Neondeck service from ${locations.unitPath}. Runtime data was left untouched.`,
      files: [locations.unitPath],
    };
  } catch (error) {
    return serviceCommandError('service_uninstall', error, changed, files);
  }
}

export async function startService(
  paths: RuntimePaths,
  options: {
    platform?: ServicePlatform;
    homeDirectory?: string;
    uid?: number;
  } = {},
): Promise<ServiceCommandResult> {
  try {
    const platform = options.platform ?? process.platform;
    if (!isSupportedServicePlatform(platform)) {
      return unsupportedResult('service_start', platform);
    }

    const locations = servicePaths(paths, {
      platform,
      homeDirectory: options.homeDirectory,
    });
    if (!existsSync(locations.unitPath)) {
      return {
        ok: false,
        action: 'service_start',
        changed: false,
        message: 'Neondeck service is not installed.',
        files: [locations.unitPath],
      };
    }

    if (platform === 'darwin') {
      await bootstrapLaunchd(locations.unitPath, options.uid);
      await runExecFile('launchctl', [
        'kickstart',
        '-k',
        `${launchdDomain(options.uid)}/${launchdLabel}`,
      ]);
    } else {
      await runExecFile('systemctl', ['--user', 'start', systemdUnitName]);
    }

    const status = await waitForServiceStatus(
      paths,
      options,
      (item) => item.running && item.health.ok,
    );
    const ok = status.running && status.health.ok;
    return {
      ok,
      action: 'service_start',
      changed: true,
      message: ok
        ? 'Started Neondeck service.'
        : 'Requested Neondeck service start, but it is not healthy yet.',
      status,
      files: [locations.unitPath],
      errors: ok
        ? undefined
        : [serviceStateError(status, 'running and healthy')],
    };
  } catch (error) {
    return serviceCommandError('service_start', error);
  }
}

export async function stopService(
  paths: RuntimePaths,
  options: {
    platform?: ServicePlatform;
    homeDirectory?: string;
    uid?: number;
  } = {},
): Promise<ServiceCommandResult> {
  try {
    const platform = options.platform ?? process.platform;
    if (!isSupportedServicePlatform(platform)) {
      return unsupportedResult('service_stop', platform);
    }

    const locations = servicePaths(paths, {
      platform,
      homeDirectory: options.homeDirectory,
    });
    if (platform === 'darwin') {
      await bootoutLaunchd(locations.unitPath, options.uid);
    } else {
      await runExecFile('systemctl', ['--user', 'stop', systemdUnitName]);
    }

    const status = await waitForServiceStatus(
      paths,
      options,
      (item) => !item.running,
    );
    const ok = !status.running;
    return {
      ok,
      action: 'service_stop',
      changed: true,
      message: ok
        ? 'Stopped Neondeck service.'
        : 'Requested Neondeck service stop, but it is still running.',
      status,
      files: [locations.unitPath],
      errors: ok ? undefined : [serviceStateError(status, 'stopped')],
    };
  } catch (error) {
    return serviceCommandError('service_stop', error);
  }
}

export async function readServiceStatus(
  paths: RuntimePaths,
  options: {
    platform?: ServicePlatform;
    homeDirectory?: string;
    commandRunner?: CommandRunner;
  } = {},
): Promise<ServiceStatus> {
  const platform = options.platform ?? process.platform;
  const locations = servicePaths(paths, {
    platform,
    homeDirectory: options.homeDirectory,
  });
  const supported = isSupportedServicePlatform(platform);
  const installed = existsSync(locations.unitPath);
  const installedConfig = installed
    ? await readInstalledServiceConfig(locations.unitPath, platform)
    : {};
  const warnings: string[] = [];
  const port = resolveStatusPort(installedConfig.port, warnings);
  const health = await probeServiceHealth(port);
  const runtimeStatus = supported
    ? await readPlatformRuntimeStatus(platform, options.commandRunner)
    : { running: false };
  const nodePath = installedConfig.nodePath;
  const serverEntry = installedConfig.serverEntry;
  const runtimeHome = installedConfig.runtimeHome;

  if (nodePath && !existsSync(nodePath)) {
    warnings.push(
      `Embedded Node path no longer exists: ${nodePath}. Re-run neondeck service install after changing Node versions.`,
    );
  }
  if (serverEntry && !existsSync(serverEntry)) {
    warnings.push(`Embedded service entry no longer exists: ${serverEntry}.`);
  }
  if (installed && !runtimeHome) {
    warnings.push(
      'Embedded service runtime home is missing. Re-run neondeck service install before using service-backed open for isolated runtime homes.',
    );
  } else if (runtimeHome && runtimeHome !== paths.home) {
    warnings.push(
      `Embedded service runtime home is ${runtimeHome}, but current runtime home is ${paths.home}.`,
    );
  }

  return {
    platform,
    supported,
    installed,
    running: runtimeStatus.running,
    pid: runtimeStatus.pid,
    unitPath: locations.unitPath,
    logPath: installedConfig.logPath ?? locations.logPath,
    port,
    health,
    nodePath,
    nodePathExists: nodePath ? existsSync(nodePath) : undefined,
    serverEntry,
    serverEntryExists: serverEntry ? existsSync(serverEntry) : undefined,
    runtimeHome,
    warnings,
  };
}

export async function readInstalledServiceConfig(
  unitPath: string,
  platform: ServicePlatform,
): Promise<InstalledServiceConfig> {
  const source = await readFile(unitPath, 'utf8').catch(() => '');
  if (!source) return {};
  return platform === 'darwin'
    ? parseLaunchdPlist(source)
    : parseSystemdUnit(source);
}

export function parseLaunchdPlist(source: string): InstalledServiceConfig {
  const programArgs = extractLaunchdArray(source, 'ProgramArguments');
  const env = extractLaunchdEnvironment(source);
  return {
    nodePath: programArgs[0],
    serverEntry: programArgs[1],
    runtimeHome: env.NEONDECK_HOME,
    port: env.NEONDECK_PORT ?? env.PORT,
    logPath: extractLaunchdString(source, 'StandardOutPath'),
  };
}

export function parseSystemdUnit(source: string): InstalledServiceConfig {
  const execStart = source
    .split('\n')
    .find((line) => line.startsWith('ExecStart='))
    ?.slice('ExecStart='.length);
  const args = execStart ? parseSystemdWords(execStart) : [];
  const env = source
    .split('\n')
    .filter((line) => line.startsWith('Environment='))
    .map((line) => parseSystemdWords(line.slice('Environment='.length))[0])
    .flatMap((entry) => {
      const separator = entry?.indexOf('=') ?? -1;
      return entry && separator > 0
        ? [[entry.slice(0, separator), entry.slice(separator + 1)] as const]
        : [];
    });
  const output = source
    .split('\n')
    .find((line) => line.startsWith('StandardOutput=append:'))
    ?.slice('StandardOutput=append:'.length);

  const envValues = Object.fromEntries(env);
  return {
    nodePath: args[0],
    serverEntry: args[1],
    runtimeHome: envValues.NEONDECK_HOME,
    port: envValues.NEONDECK_PORT ?? envValues.PORT,
    logPath: output,
  };
}

function serviceDefinitionOptions(
  options: ServiceInstallOptions,
): ServiceDefinitionOptions {
  const serverEntry = options.serverEntry ?? resolvePackagedServerEntry();
  return {
    nodePath: options.nodePath ?? process.execPath,
    serverEntry,
    runtimeHome: options.paths.home,
    logPath: servicePaths(options.paths, {
      platform: options.platform,
      homeDirectory: options.homeDirectory,
    }).logPath,
    port: resolveServerPort(options.port),
    workingDirectory:
      options.workingDirectory ?? packageRootForServerEntry(serverEntry),
  };
}

function isSupportedServicePlatform(platform: ServicePlatform) {
  return platform === 'darwin' || platform === 'linux';
}

function unsupportedResult(
  action: string,
  platform: ServicePlatform,
): ServiceCommandResult {
  return {
    ok: false,
    action,
    changed: false,
    message: `Service management is not supported on ${platform}. Use neondeck serve instead.`,
  };
}

async function waitForServiceStatus(
  paths: RuntimePaths,
  options: {
    platform?: ServicePlatform;
    homeDirectory?: string;
    commandRunner?: CommandRunner;
  },
  ready: (status: ServiceStatus) => boolean,
) {
  const deadline = Date.now() + 5_000;
  let status = await readServiceStatus(paths, options);
  while (!ready(status) && Date.now() < deadline) {
    await sleep(250);
    status = await readServiceStatus(paths, options);
  }
  return status;
}

function serviceStateError(status: ServiceStatus, expected: string) {
  const health = status.health.ok
    ? `health ok (${status.health.status ?? 200})`
    : `health down (${status.health.error ?? status.health.status ?? 'unknown'})`;
  return `Expected service to be ${expected}; running=${status.running}, ${health}.`;
}

function serviceCommandError(
  action: string,
  error: unknown,
  changed = false,
  files?: string[],
): ServiceCommandResult {
  return {
    ok: false,
    action,
    changed,
    message: `${serviceActionTitle(action)} failed.`,
    files,
    errors: [error instanceof Error ? error.message : String(error)],
  };
}

function serviceActionTitle(action: string) {
  return action.replace(/^service_/, 'service ').replaceAll('_', ' ');
}

function resolveStatusPort(value: string | undefined, warnings: string[]) {
  try {
    return resolveServerPort(value);
  } catch (error) {
    warnings.push(
      `Embedded service port is invalid; falling back to ${defaultServerPort}. ${error instanceof Error ? error.message : String(error)}`,
    );
    return defaultServerPort;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMissingServiceError(error: unknown) {
  const text = errorText(error).toLowerCase();
  return (
    text.includes('no such process') ||
    text.includes('could not find service') ||
    text.includes('service is not loaded') ||
    text.includes('no such file')
  );
}

function isAlreadyLoadedError(error: unknown) {
  const text = errorText(error).toLowerCase();
  return (
    text.includes('service already loaded') ||
    text.includes('already bootstrapped') ||
    text.includes('bootstrap failed: 5')
  );
}

function errorText(error: unknown) {
  if (!error || typeof error !== 'object') {
    return error instanceof Error ? error.message : String(error);
  }
  const record = error as {
    message?: unknown;
    stdout?: unknown;
    stderr?: unknown;
  };
  return [record.message, record.stdout, record.stderr]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
}

async function readPlatformRuntimeStatus(
  platform: ServicePlatform,
  commandRunner: CommandRunner = runExecFile,
) {
  if (platform === 'darwin') {
    const output = await commandRunner('launchctl', [
      'print',
      `${launchdDomain()}/${launchdLabel}`,
    ]).catch(() => ({ stdout: '', stderr: '' }));
    const match = output.stdout.match(/^\s*pid\s*=\s*(\d+)/m);
    return {
      running: Boolean(match),
      pid: match ? Number(match[1]) : undefined,
    };
  }

  if (platform === 'linux') {
    const output = await commandRunner('systemctl', [
      '--user',
      'show',
      systemdUnitName,
      '--property=ActiveState,MainPID',
    ]).catch(() => ({ stdout: '', stderr: '' }));
    const active = output.stdout.match(/^ActiveState=(.+)$/m)?.[1];
    const pid = output.stdout.match(/^MainPID=(\d+)$/m)?.[1];
    return {
      running: active === 'active',
      pid: pid && pid !== '0' ? Number(pid) : undefined,
    };
  }

  return { running: false };
}

async function probeServiceHealth(port: number): Promise<ServiceHealth> {
  const url = `http://127.0.0.1:${port}/api/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 750);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return { ok: response.ok, url, status: response.status };
  } catch (error) {
    return {
      ok: false,
      url,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function bootoutLaunchd(unitPath: string, uid?: number) {
  try {
    await runExecFile('launchctl', ['bootout', launchdDomain(uid), unitPath]);
  } catch (error) {
    if (isMissingServiceError(error)) return;
    throw error;
  }
}

async function bootstrapLaunchd(unitPath: string, uid?: number) {
  try {
    await runExecFile('launchctl', ['bootstrap', launchdDomain(uid), unitPath]);
  } catch (error) {
    if (isAlreadyLoadedError(error)) return;
    throw error;
  }
}

function launchdDomain(uid = process.getuid?.() ?? 0) {
  return `gui/${uid}`;
}

function escapeXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function systemdQuote(value: string) {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function extractLaunchdArray(source: string, key: string) {
  const match = source.match(
    new RegExp(
      `<key>${escapeRegExp(key)}</key>\\s*<array>([\\s\\S]*?)</array>`,
    ),
  );
  if (!match) return [];
  return [...match[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((item) =>
    unescapeXml(item[1].trim()),
  );
}

function extractLaunchdEnvironment(source: string) {
  const match = source.match(
    /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/,
  );
  if (!match) return {} as Record<string, string>;
  const env: Record<string, string> = {};
  const pairs = [
    ...match[1].matchAll(
      /<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g,
    ),
  ];
  for (const pair of pairs) env[unescapeXml(pair[1])] = unescapeXml(pair[2]);
  return env;
}

function extractLaunchdString(source: string, key: string) {
  const match = source.match(
    new RegExp(
      `<key>${escapeRegExp(key)}</key>\\s*<string>([\\s\\S]*?)</string>`,
    ),
  );
  return match ? unescapeXml(match[1].trim()) : undefined;
}

function parseSystemdWords(value: string) {
  const words: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const char of value.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === '\\') {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current) words.push(current);
  return words;
}

function unescapeXml(value: string) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&');
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
