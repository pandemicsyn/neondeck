import { mkdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
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
  await seedRuntimeSkills(paths);
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
  seedRuntimeSkillsSync(paths);
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
