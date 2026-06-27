import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';

export type RuntimeHomeEnv = Partial<
  Pick<NodeJS.ProcessEnv, 'NEONDECK_HOME' | 'XDG_CONFIG_HOME' | 'HOME'>
>;

export type RuntimePaths = {
  home: string;
  config: string;
  repos: string;
  dashboard: string;
  schedules: string;
  soul: string;
  skills: string;
  neondeckSkill: string;
  data: string;
  neondeckDatabase: string;
  flueDatabase: string;
};

const unknownRecordSchema = v.record(v.string(), v.unknown());
const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
const positiveIntegerSchema = v.pipe(v.number(), v.integer(), v.minValue(1));

export const appConfigSchema = v.looseObject({
  version: positiveIntegerSchema,
});

export const repoConfigSchema = v.looseObject({
  id: nonEmptyStringSchema,
  github: v.object({
    owner: nonEmptyStringSchema,
    name: nonEmptyStringSchema,
  }),
  path: nonEmptyStringSchema,
  defaultBranch: nonEmptyStringSchema,
  productionTarget: v.optional(nonEmptyStringSchema),
  packageScripts: v.optional(v.record(v.string(), v.string())),
  metadata: v.optional(unknownRecordSchema),
  watchRules: v.optional(v.array(v.unknown())),
});

export const repoRegistrySchema = v.looseObject({
  repos: v.array(repoConfigSchema),
});

export const scheduleEntrySchema = v.looseObject({
  id: nonEmptyStringSchema,
  type: nonEmptyStringSchema,
  enabled: v.optional(v.boolean()),
  timezone: v.optional(nonEmptyStringSchema),
  cron: v.optional(nonEmptyStringSchema),
  preset: v.optional(nonEmptyStringSchema),
  config: v.optional(unknownRecordSchema),
});

export const scheduleConfigSchema = v.looseObject({
  schedules: v.array(scheduleEntrySchema),
});

export const dashboardRegionSchema = v.looseObject({
  id: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  pluginId: nonEmptyStringSchema,
  column: positiveIntegerSchema,
  row: positiveIntegerSchema,
  columnSpan: positiveIntegerSchema,
  rowSpan: positiveIntegerSchema,
  config: unknownRecordSchema,
});

export const dashboardConfigSchema = v.looseObject({
  display: v.object({
    width: positiveIntegerSchema,
    height: positiveIntegerSchema,
  }),
  theme: v.picklist(['light', 'dark', 'system']),
  layout: v.object({
    columns: positiveIntegerSchema,
    rows: positiveIntegerSchema,
    regions: v.array(dashboardRegionSchema),
  }),
});

export type AppConfig = v.InferOutput<typeof appConfigSchema>;
export type RepoConfig = v.InferOutput<typeof repoConfigSchema>;
export type RepoRegistry = v.InferOutput<typeof repoRegistrySchema>;
export type ScheduleEntry = v.InferOutput<typeof scheduleEntrySchema>;
export type ScheduleConfig = v.InferOutput<typeof scheduleConfigSchema>;
export type DashboardConfig = v.InferOutput<typeof dashboardConfigSchema>;
export type DashboardRegion = v.InferOutput<typeof dashboardRegionSchema>;

export class ConfigValidationError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'ConfigValidationError';
  }
}

const defaultDashboardPath = fileURLToPath(
  new URL('../config/dashboard.json', import.meta.url),
);
const defaultSoulPath = fileURLToPath(new URL('../SOUL.md', import.meta.url));

export function resolveRuntimeHome(env: RuntimeHomeEnv = process.env) {
  if (env.NEONDECK_HOME) {
    return expandHome(env.NEONDECK_HOME, env);
  }

  if (env.XDG_CONFIG_HOME) {
    return join(expandHome(env.XDG_CONFIG_HOME, env), 'neondeck');
  }

  return join(env.HOME ?? homedir(), '.config', 'neondeck');
}

export function runtimePaths(home = resolveRuntimeHome()): RuntimePaths {
  return {
    home,
    config: join(home, 'config.json'),
    repos: join(home, 'repos.json'),
    dashboard: join(home, 'dashboard.json'),
    schedules: join(home, 'schedules.json'),
    soul: join(home, 'SOUL.md'),
    skills: join(home, 'skills'),
    neondeckSkill: join(home, 'skills', 'neondeck', 'SKILL.md'),
    data: join(home, 'data'),
    neondeckDatabase: join(home, 'data', 'neondeck.db'),
    flueDatabase: join(home, 'data', 'flue.db'),
  };
}

export async function ensureRuntimeHome(paths = runtimePaths()) {
  await mkdir(paths.home, { recursive: true });
  await mkdir(paths.data, { recursive: true });
  await mkdir(dirname(paths.neondeckSkill), { recursive: true });

  await writeJsonIfMissing(paths.config, { version: 1 });
  await writeJsonIfMissing(paths.repos, { repos: [] });
  await writeJsonIfMissing(paths.schedules, { schedules: [] });
  await copyIfMissing(defaultDashboardPath, paths.dashboard);
  await copyIfMissing(defaultSoulPath, paths.soul);
  await writeFileIfMissing(paths.neondeckSkill, runtimeSkillMarkdown(paths));
  initializeAppDatabase(paths.neondeckDatabase);
  initializeFlueDatabase(paths.flueDatabase);
}

export function ensureRuntimeHomeSync(paths = runtimePaths()) {
  mkdirSync(paths.home, { recursive: true });
  mkdirSync(paths.data, { recursive: true });
  mkdirSync(dirname(paths.neondeckSkill), { recursive: true });

  writeJsonIfMissingSync(paths.config, { version: 1 });
  writeJsonIfMissingSync(paths.repos, { repos: [] });
  writeJsonIfMissingSync(paths.schedules, { schedules: [] });
  copyIfMissingSync(defaultDashboardPath, paths.dashboard);
  copyIfMissingSync(defaultSoulPath, paths.soul);
  writeFileIfMissingSync(paths.neondeckSkill, runtimeSkillMarkdown(paths));
  initializeAppDatabase(paths.neondeckDatabase);
  initializeFlueDatabase(paths.flueDatabase);
}

export async function readRuntimeJson<T>(
  path: string,
  parse: (value: unknown, path: string) => T,
): Promise<T> {
  const source = await readFile(path, 'utf8');
  return parseJson(source, path, parse);
}

export function readRuntimeJsonSync<T>(
  path: string,
  parse: (value: unknown, path: string) => T,
): T {
  const source = readFileSync(path, 'utf8');
  return parseJson(source, path, parse);
}

export async function validateRuntimeFiles(paths = runtimePaths()) {
  await readRuntimeJson(paths.config, parseAppConfig);
  await readRuntimeJson(paths.repos, parseRepoRegistry);
  await readRuntimeJson(paths.dashboard, parseDashboardConfig);
  await readRuntimeJson(paths.schedules, parseScheduleConfig);
}

export function validateRuntimeFilesSync(paths = runtimePaths()) {
  readRuntimeJsonSync(paths.config, parseAppConfig);
  readRuntimeJsonSync(paths.repos, parseRepoRegistry);
  readRuntimeJsonSync(paths.dashboard, parseDashboardConfig);
  readRuntimeJsonSync(paths.schedules, parseScheduleConfig);
}

function expandHome(path: string, env: RuntimeHomeEnv) {
  if (path === '~') {
    return env.HOME ?? homedir();
  }

  if (path.startsWith('~/')) {
    return join(env.HOME ?? homedir(), path.slice(2));
  }

  return resolve(path);
}

async function writeJsonIfMissing(path: string, value: unknown) {
  await writeFileIfMissing(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonIfMissingSync(path: string, value: unknown) {
  writeFileIfMissingSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeFileIfMissing(path: string, value: string) {
  if (existsSync(path)) {
    return;
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, 'utf8');
}

function writeFileIfMissingSync(path: string, value: string) {
  if (existsSync(path)) {
    return;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, 'utf8');
}

async function copyIfMissing(source: string, target: string) {
  if (existsSync(target)) {
    return;
  }

  await mkdir(dirname(target), { recursive: true });
  await cp(source, target);
}

function copyIfMissingSync(source: string, target: string) {
  if (existsSync(target)) {
    return;
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, readFileSync(source));
}

function initializeAppDatabase(path: string) {
  const database = new DatabaseSync(path);

  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS app_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS config_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        file TEXT NOT NULL,
        target TEXT,
        before_json TEXT,
        after_json TEXT,
        changed_at TEXT NOT NULL
      );
    `);

    database
      .prepare(
        `
        INSERT INTO app_metadata (key, value, updated_at)
        VALUES ('schema_version', '2', datetime('now'))
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at;
      `,
      )
      .run();
  } finally {
    database.close();
  }
}

function initializeFlueDatabase(path: string) {
  const database = new DatabaseSync(path);
  database.close();
}

function parseJson<T>(
  source: string,
  path: string,
  parse: (value: unknown, path: string) => T,
) {
  try {
    return parse(JSON.parse(source) as unknown, path);
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigValidationError(path, message);
  }
}

export function parseAppConfig(value: unknown, path: string): AppConfig {
  return parseSchema(appConfigSchema, value, path);
}

export function parseRepoRegistry(value: unknown, path: string): RepoRegistry {
  return parseSchema(repoRegistrySchema, value, path);
}

export function parseScheduleConfig(
  value: unknown,
  path: string,
): ScheduleConfig {
  return parseSchema(scheduleConfigSchema, value, path);
}

export function parseDashboardConfig(
  value: unknown,
  path: string,
): DashboardConfig {
  return parseSchema(dashboardConfigSchema, value, path);
}

function parseSchema<T>(
  schema: v.GenericSchema<unknown, T>,
  value: unknown,
  path: string,
): T {
  const result = v.safeParse(schema, value);

  if (result.success) {
    return result.output;
  }

  throw new ConfigValidationError(path, v.summarize(result.issues));
}

function runtimeSkillMarkdown(paths: RuntimePaths) {
  return `# neondeck Runtime Skill

Neon runs inside neondeck, a local-first developer cockpit for a companion display.

## Runtime Home

Configuration and mutable runtime state live in:

\`\`\`text
${paths.home}
\`\`\`

Home resolution order is \`NEONDECK_HOME\`, then \`XDG_CONFIG_HOME/neondeck\`, then \`~/.config/neondeck\`.

## Files

- \`config.json\`: top-level app settings.
- \`repos.json\`: configured local repositories and GitHub metadata.
- \`dashboard.json\`: dashboard layout and plugin configuration.
- \`schedules.json\`: local schedule and briefing configuration.
- \`SOUL.md\`: stable assistant personality loaded at session start.
- \`skills/\`: runtime skill folders. Users can add additional Agent Skills-compatible folders here.
- \`data/neondeck.db\`: neondeck app state.
- \`data/flue.db\`: Flue runtime state.

## Mutation Rules

Use typed neondeck config actions for mutations whenever they are available. Do not directly edit config files as the primary path. Read, validate, add, update, remove, and reload through deterministic actions so UI buttons and chat commands share the same backend behavior.

Ask for confirmation before destructive changes, removing configured repositories, deleting schedules, disabling watches, or replacing user-authored skills. After any accepted change, summarize exactly which file or runtime object changed and what the new value is.
`;
}
