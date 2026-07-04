import { mkdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';

import { initializeAppDatabase, initializeFlueDatabase } from './app-db';
import { defaultAppConfig } from './defaults';
import { defaultMcpConfig } from '../domains/mcp/schemas';
import {
  copyIfMissing,
  copyIfMissingSync,
  ensureLocalApiConfig,
  ensureLocalApiConfigSync,
  writeFileIfMissing,
  writeFileIfMissingSync,
  writeJsonIfMissing,
  writeJsonIfMissingSync,
} from './files';
import {
  defaultDashboardPath,
  defaultDashboardSchemaPath,
  defaultSoulPath,
  runtimePaths,
} from './paths';

export async function ensureRuntimeHome(paths = runtimePaths()) {
  await mkdir(paths.home, { recursive: true });
  await mkdir(paths.data, { recursive: true });
  await mkdir(paths.skills, { recursive: true });
  await mkdir(paths.worktrees, { recursive: true });

  await writeFileIfMissing(paths.env, '');
  await writeJsonIfMissing(paths.config, defaultAppConfig());
  await ensureLocalApiConfig(paths.config);
  await writeJsonIfMissing(paths.mcp, defaultMcpConfig());
  await writeJsonIfMissing(paths.repos, { repos: [] });
  await writeJsonIfMissing(paths.schedules, { schedules: [] });
  await copyIfMissing(defaultDashboardPath, paths.dashboard);
  await copyIfMissing(defaultDashboardSchemaPath, paths.dashboardSchema);
  await copyIfMissing(defaultSoulPath, paths.soul);
  initializeAppDatabase(paths.neondeckDatabase);
  initializeFlueDatabase(paths.flueDatabase);
}

export function ensureRuntimeHomeSync(paths = runtimePaths()) {
  mkdirSync(paths.home, { recursive: true });
  mkdirSync(paths.data, { recursive: true });
  mkdirSync(paths.skills, { recursive: true });
  mkdirSync(paths.worktrees, { recursive: true });

  writeFileIfMissingSync(paths.env, '');
  writeJsonIfMissingSync(paths.config, defaultAppConfig());
  ensureLocalApiConfigSync(paths.config);
  writeJsonIfMissingSync(paths.mcp, defaultMcpConfig());
  writeJsonIfMissingSync(paths.repos, { repos: [] });
  writeJsonIfMissingSync(paths.schedules, { schedules: [] });
  copyIfMissingSync(defaultDashboardPath, paths.dashboard);
  copyIfMissingSync(defaultDashboardSchemaPath, paths.dashboardSchema);
  copyIfMissingSync(defaultSoulPath, paths.soul);
  initializeAppDatabase(paths.neondeckDatabase);
  initializeFlueDatabase(paths.flueDatabase);
}
