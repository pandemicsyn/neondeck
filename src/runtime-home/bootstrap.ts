import { existsSync, mkdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  initializeAppDatabase,
  initializeFlueDatabase,
} from './app-db/index.ts';
import { defaultAppConfig } from './defaults.ts';
import { defaultMcpConfig } from '../domains/mcp/schemas.ts';
import {
  copyIfMissing,
  copyIfMissingSync,
  ensureLocalApiConfig,
  ensureLocalApiConfigSync,
  writeFileIfMissing,
  writeFileIfMissingSync,
  writeJsonIfMissing,
  writeJsonIfMissingSync,
} from './files.ts';
import {
  defaultDashboardPath,
  defaultDashboardSchemaPath,
  defaultSoulPath,
  runtimePaths,
} from './paths.ts';

const seededRuntimeSkills = [
  {
    id: 'neon-pr-review',
    source: fileURLToPath(
      new URL('../skills/neon-pr-review/SKILL.md', import.meta.url),
    ),
  },
  {
    id: 'neon-ci-fix',
    source: fileURLToPath(
      new URL('../skills/neon-ci-fix/SKILL.md', import.meta.url),
    ),
  },
  {
    id: 'neon-docs-fix',
    source: fileURLToPath(
      new URL('../skills/neon-docs-fix/SKILL.md', import.meta.url),
    ),
  },
  {
    id: 'neon-issue-triage',
    source: fileURLToPath(
      new URL('../skills/neon-issue-triage/SKILL.md', import.meta.url),
    ),
  },
];

const initializedRuntimeDatabases = new Set<string>();
const pendingRuntimeDatabaseInitializations = new Map<string, Promise<void>>();

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
  await copyIfMissing(defaultDashboardPath, paths.dashboard);
  await copyIfMissing(defaultDashboardSchemaPath, paths.dashboardSchema);
  await copyIfMissing(defaultSoulPath, paths.soul);
  await seedRuntimeSkills(paths);
  await ensureRuntimeDatabases(paths);
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
  copyIfMissingSync(defaultDashboardPath, paths.dashboard);
  copyIfMissingSync(defaultDashboardSchemaPath, paths.dashboardSchema);
  copyIfMissingSync(defaultSoulPath, paths.soul);
  seedRuntimeSkillsSync(paths);
  ensureRuntimeDatabasesSync(paths);
}

async function ensureRuntimeDatabases(paths = runtimePaths()) {
  const key = runtimeDatabaseKey(paths);
  if (runtimeDatabasesAreInitialized(key, paths)) return;

  const pending = pendingRuntimeDatabaseInitializations.get(key);
  if (pending) {
    await pending;
    return;
  }

  const initialization = Promise.resolve()
    .then(() => {
      initializeRuntimeDatabases(paths);
      initializedRuntimeDatabases.add(key);
    })
    .finally(() => {
      pendingRuntimeDatabaseInitializations.delete(key);
    });
  pendingRuntimeDatabaseInitializations.set(key, initialization);
  await initialization;
}

function ensureRuntimeDatabasesSync(paths = runtimePaths()) {
  const key = runtimeDatabaseKey(paths);
  if (runtimeDatabasesAreInitialized(key, paths)) return;
  initializeRuntimeDatabases(paths);
  initializedRuntimeDatabases.add(key);
}

function initializeRuntimeDatabases(paths = runtimePaths()) {
  initializeAppDatabase(paths.neondeckDatabase);
  initializeFlueDatabase(paths.flueDatabase);
}

async function seedRuntimeSkills(paths = runtimePaths()) {
  await Promise.all(
    seededRuntimeSkills.map((skill) =>
      copyIfMissing(skill.source, join(paths.skills, skill.id, 'SKILL.md')),
    ),
  );
}

function seedRuntimeSkillsSync(paths = runtimePaths()) {
  for (const skill of seededRuntimeSkills) {
    copyIfMissingSync(skill.source, join(paths.skills, skill.id, 'SKILL.md'));
  }
}

function runtimeDatabaseKey(paths = runtimePaths()) {
  return `${resolve(paths.neondeckDatabase)}\0${resolve(paths.flueDatabase)}`;
}

function runtimeDatabasesAreInitialized(key: string, paths = runtimePaths()) {
  return (
    initializedRuntimeDatabases.has(key) &&
    existsSync(paths.neondeckDatabase) &&
    existsSync(paths.flueDatabase)
  );
}
