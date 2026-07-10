import { configEventFromChange, publishConfigEvent } from './events';
import { okResult, failResult, errorMessage } from './result';
import type { ConfigActionResult, ConfigTarget } from './schemas';
import { parseMcpConfig } from '../../domains/mcp/schemas';
import {
  ensureRuntimeHome,
  parseAppConfig,
  parseDashboardConfig,
  parseRepoRegistry,
  readRuntimeJson,
  runtimePaths,
  validateRuntimeFiles,
  type AppConfig,
  type RuntimePaths,
} from '../../runtime-home';

export async function readConfig(
  input: { target?: ConfigTarget } = {},
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const target = input.target ?? 'all';
  const data = await readTarget(target, paths);

  return okResult('config_read', false, paths, targetFiles(target, paths), {
    message: `Read ${target} config.`,
    data,
  });
}

export async function validateConfig(
  input: { target?: ConfigTarget } = {},
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const target = input.target ?? 'all';

  try {
    await readTarget(target, paths);
    return okResult(
      'config_validate',
      false,
      paths,
      targetFiles(target, paths),
      {
        message: `Validated ${target} config.`,
      },
    );
  } catch (error) {
    return failResult('config_validate', paths, targetFiles(target, paths), {
      message: `Invalid ${target} config.`,
      errors: [errorMessage(error)],
    });
  }
}

export async function reloadConfig(
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  await validateRuntimeFiles(paths);
  const changedAt = new Date().toISOString();
  publishConfigEvent(
    configEventFromChange(paths, {
      action: 'config_reload',
      changed: false,
      files: targetFiles('all', paths),
      target: 'all',
      changedAt,
    }),
  );

  return okResult('config_reload', false, paths, targetFiles('all', paths), {
    message:
      'Runtime config reloaded. Neondeck reads config from disk, so no process restart was required.',
    data: await readTarget('all', paths),
  });
}

async function readTarget(target: ConfigTarget, paths: RuntimePaths) {
  if (target === 'config') {
    return {
      config: publicAppConfig(
        await readRuntimeJson(paths.config, parseAppConfig),
      ),
    };
  }

  if (target === 'repos') {
    return { repos: await readRuntimeJson(paths.repos, parseRepoRegistry) };
  }

  if (target === 'mcp') {
    return { mcp: await readRuntimeJson(paths.mcp, parseMcpConfig) };
  }

  if (target === 'dashboard') {
    return {
      dashboard: await readRuntimeJson(paths.dashboard, parseDashboardConfig),
    };
  }

  return {
    config: publicAppConfig(
      await readRuntimeJson(paths.config, parseAppConfig),
    ),
    mcp: await readRuntimeJson(paths.mcp, parseMcpConfig),
    repos: await readRuntimeJson(paths.repos, parseRepoRegistry),
    dashboard: await readRuntimeJson(paths.dashboard, parseDashboardConfig),
  };
}

export function targetFiles(target: ConfigTarget, paths: RuntimePaths) {
  if (target === 'config') return [paths.config];
  if (target === 'mcp') return [paths.mcp];
  if (target === 'repos') return [paths.repos];
  if (target === 'dashboard') return [paths.dashboard];
  return [
    paths.config,
    paths.mcp,
    paths.repos,
    paths.dashboard,
  ];
}

function publicAppConfig(config: AppConfig) {
  if (!config.localApi) return config;
  return {
    ...config,
    localApi: {
      ...config.localApi,
      token: '[redacted-local-api-token]',
    },
  };
}
