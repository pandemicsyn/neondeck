import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  initializeAppDatabase,
  initializeFlueDatabase,
} from './app-db/index.ts';
import { defaultAppConfig } from './defaults.ts';
import { defaultMcpConfig } from '../domains/mcp/schemas.ts';
import {
  migrateDashboardConfig,
  migrateDashboardConfigSync,
} from './dashboard-migrations.ts';
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
import { resolveShippedAsset } from './assets.ts';

const seededRuntimeSkills = [
  {
    id: 'neon-pr-review',
    source: resolveShippedAsset(
      'src/skills/neon-pr-review/SKILL.md',
      'skills/neon-pr-review/SKILL.md',
    ),
  },
  {
    id: 'neon-issue-triage',
    source: resolveShippedAsset(
      'src/skills/neon-issue-triage/SKILL.md',
      'skills/neon-issue-triage/SKILL.md',
    ),
  },
];

const initializedRuntimeDatabases = new Set<string>();
const pendingRuntimeHomeInitializations = new Map<string, Promise<void>>();
const pendingRuntimeDatabaseInitializations = new Map<string, Promise<void>>();

export async function ensureRuntimeHome(paths = runtimePaths()) {
  const key = resolve(paths.home);
  const pending = pendingRuntimeHomeInitializations.get(key);
  if (pending) {
    await pending;
    return;
  }

  const initialization = initializeRuntimeHome(paths).finally(() => {
    if (pendingRuntimeHomeInitializations.get(key) === initialization) {
      pendingRuntimeHomeInitializations.delete(key);
    }
  });
  pendingRuntimeHomeInitializations.set(key, initialization);
  await initialization;
}

async function initializeRuntimeHome(paths = runtimePaths()) {
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
  await migrateDashboardConfig(paths.dashboard);
  await copyIfMissing(defaultDashboardSchemaPath, paths.dashboardSchema);
  await copyIfMissing(defaultSoulPath, paths.soul);
  await seedRuntimeSkills(paths);
  await ensureOnboardingPendingMarker(paths);
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
  migrateDashboardConfigSync(paths.dashboard);
  copyIfMissingSync(defaultDashboardSchemaPath, paths.dashboardSchema);
  copyIfMissingSync(defaultSoulPath, paths.soul);
  seedRuntimeSkillsSync(paths);
  ensureOnboardingPendingMarkerSync(paths);
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
  const onboardingPendingMarker = onboardingPendingMarkerPath(paths);
  initializeAppDatabase(paths.neondeckDatabase, {
    onboardingPending: existsSync(onboardingPendingMarker),
  });
  rmSync(onboardingPendingMarker, { force: true });
  initializeFlueDatabase(paths.flueDatabase);
}

async function ensureOnboardingPendingMarker(paths = runtimePaths()) {
  if (existsSync(paths.neondeckDatabase)) return;
  await writeFileIfMissing(
    onboardingPendingMarkerPath(paths),
    'Neondeck onboarding is pending. This file is managed automatically.\n',
  );
}

function ensureOnboardingPendingMarkerSync(paths = runtimePaths()) {
  if (existsSync(paths.neondeckDatabase)) return;
  writeFileIfMissingSync(
    onboardingPendingMarkerPath(paths),
    'Neondeck onboarding is pending. This file is managed automatically.\n',
  );
}

function onboardingPendingMarkerPath(paths = runtimePaths()) {
  return join(paths.home, '.onboarding-pending');
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
