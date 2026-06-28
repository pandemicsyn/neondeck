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
  env: string;
  config: string;
  repos: string;
  dashboard: string;
  dashboardSchema: string;
  schedules: string;
  soul: string;
  skills: string;
  data: string;
  neondeckDatabase: string;
  flueDatabase: string;
};

const unknownRecordSchema = v.record(v.string(), v.unknown());
const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
const positiveIntegerSchema = v.pipe(v.number(), v.integer(), v.minValue(1));
const dashboardDensitySchema = v.picklist([
  'compact',
  'comfortable',
  'large',
]);
const dashboardTextScaleSchema = v.pipe(
  v.number(),
  v.minValue(0.9),
  v.maxValue(1.4),
);
const envVarNameSchema = v.pipe(
  v.string(),
  v.regex(/^[A-Z_][A-Z0-9_]*$/, 'Expected an environment variable name.'),
);

export const agentModelConfigSchema = v.looseObject({
  default: v.optional(nonEmptyStringSchema),
  displayAssistant: v.optional(nonEmptyStringSchema),
  subagents: v.optional(
    v.looseObject({
      default: v.optional(nonEmptyStringSchema),
      repoResearcher: v.optional(nonEmptyStringSchema),
      ciInvestigator: v.optional(nonEmptyStringSchema),
      releaseReviewer: v.optional(nonEmptyStringSchema),
    }),
  ),
});

export const providerConfigSchema = v.strictObject({
  kilocode: v.optional(
    v.strictObject({
      enabled: v.optional(v.boolean()),
      apiKeyEnv: v.optional(envVarNameSchema),
      organizationIdEnv: v.optional(envVarNameSchema),
    }),
  ),
});

const executionBackendSchema = v.picklist(['local', 'exe.dev']);
const executionApprovalModeSchema = v.picklist(['manual', 'off']);
const executionUnattendedModeSchema = v.picklist(['deny', 'allow-preapproved']);
const executionCommandMatchSchema = v.picklist(['exact', 'prefix', 'glob']);
const executionSandboxLifecycleSchema = v.picklist([
  'existing-vm',
  'fresh-per-execution',
  'reuse-session',
  'reuse-repo',
  'user-selected',
]);
const shellOperatorFreeCommandSchema = v.pipe(
  nonEmptyStringSchema,
  v.check(
    (value) => !hasShellOperator(value),
    'Preapproved commands must be a single command without shell operators.',
  ),
);

export const executionPreapprovedCommandSchema = v.looseObject({
  id: v.optional(nonEmptyStringSchema),
  command: shellOperatorFreeCommandSchema,
  match: v.optional(executionCommandMatchSchema),
  backends: v.optional(v.array(executionBackendSchema)),
  description: v.optional(nonEmptyStringSchema),
});

export const executionConfigSchema = v.looseObject({
  defaultBackend: v.optional(executionBackendSchema),
  enabledBackends: v.optional(v.array(executionBackendSchema)),
  approvalMode: v.optional(executionApprovalModeSchema),
  unattended: v.optional(executionUnattendedModeSchema),
  preapprovedCommands: v.optional(v.array(executionPreapprovedCommandSchema)),
  exeDev: v.optional(
    v.strictObject({
      apiTokenEnv: v.optional(envVarNameSchema),
      lifecycle: v.optional(executionSandboxLifecycleSchema),
      sshKeyEnv: v.optional(envVarNameSchema),
      vmHostEnv: v.optional(envVarNameSchema),
    }),
  ),
});

export const appConfigSchema = v.looseObject({
  version: positiveIntegerSchema,
  skillRoots: v.optional(v.array(nonEmptyStringSchema)),
  models: v.optional(agentModelConfigSchema),
  providers: v.optional(providerConfigSchema),
  execution: v.optional(executionConfigSchema),
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

export const dashboardTabSchema = v.looseObject({
  id: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  pluginId: nonEmptyStringSchema,
  config: v.optional(unknownRecordSchema),
});

export const dashboardRegionSchema = v.looseObject({
  id: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  column: positiveIntegerSchema,
  row: positiveIntegerSchema,
  columnSpan: positiveIntegerSchema,
  rowSpan: positiveIntegerSchema,
  defaultTab: v.optional(nonEmptyStringSchema),
  tabs: v.pipe(v.array(dashboardTabSchema), v.minLength(1)),
});

export const dashboardConfigSchema = v.looseObject({
  $schema: v.optional(v.string()),
  display: v.object({
    preset: v.optional(nonEmptyStringSchema),
    width: positiveIntegerSchema,
    height: positiveIntegerSchema,
  }),
  theme: v.picklist(['light', 'dark', 'system']),
  appearance: v.optional(
    v.looseObject({
      density: v.optional(dashboardDensitySchema),
      textScale: v.optional(dashboardTextScaleSchema),
    }),
  ),
  statusline: v.optional(
    v.looseObject({
      position: v.picklist(['top', 'bottom']),
      pluginId: nonEmptyStringSchema,
      config: v.optional(unknownRecordSchema),
    }),
  ),
  layout: v.object({
    mode: v.optional(v.picklist(['auto', 'xeneon', 'stacked'])),
    columns: positiveIntegerSchema,
    rows: positiveIntegerSchema,
    regions: v.array(dashboardRegionSchema),
  }),
});

export type AppConfig = v.InferOutput<typeof appConfigSchema>;
export type AgentModelConfig = v.InferOutput<typeof agentModelConfigSchema>;
export type ProviderConfig = v.InferOutput<typeof providerConfigSchema>;
export type ExecutionConfig = v.InferOutput<typeof executionConfigSchema>;
export type ExecutionBackend = v.InferOutput<typeof executionBackendSchema>;
export type ExecutionPreapprovedCommand = v.InferOutput<
  typeof executionPreapprovedCommandSchema
>;
export type RepoConfig = v.InferOutput<typeof repoConfigSchema>;
export type RepoRegistry = v.InferOutput<typeof repoRegistrySchema>;
export type ScheduleEntry = v.InferOutput<typeof scheduleEntrySchema>;
export type ScheduleConfig = v.InferOutput<typeof scheduleConfigSchema>;
export type DashboardConfig = v.InferOutput<typeof dashboardConfigSchema>;
export type DashboardRegion = v.InferOutput<typeof dashboardRegionSchema>;
export type DashboardTab = v.InferOutput<typeof dashboardTabSchema>;

export class ConfigValidationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.path = path;
    this.name = 'ConfigValidationError';
  }
}

const defaultDashboardPath = fileURLToPath(
  new URL('../config/dashboard.json', import.meta.url),
);
const defaultDashboardSchemaPath = fileURLToPath(
  new URL('../config/dashboard.schema.json', import.meta.url),
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
    env: join(home, '.env'),
    config: join(home, 'config.json'),
    repos: join(home, 'repos.json'),
    dashboard: join(home, 'dashboard.json'),
    dashboardSchema: join(home, 'dashboard.schema.json'),
    schedules: join(home, 'schedules.json'),
    soul: join(home, 'SOUL.md'),
    skills: join(home, 'skills'),
    data: join(home, 'data'),
    neondeckDatabase: join(home, 'data', 'neondeck.db'),
    flueDatabase: join(home, 'data', 'flue.db'),
  };
}

export async function ensureRuntimeHome(paths = runtimePaths()) {
  await mkdir(paths.home, { recursive: true });
  await mkdir(paths.data, { recursive: true });
  await mkdir(paths.skills, { recursive: true });

  await writeFileIfMissing(paths.env, '');
  await writeJsonIfMissing(paths.config, { version: 1 });
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

  writeFileIfMissingSync(paths.env, '');
  writeJsonIfMissingSync(paths.config, { version: 1 });
  writeJsonIfMissingSync(paths.repos, { repos: [] });
  writeJsonIfMissingSync(paths.schedules, { schedules: [] });
  copyIfMissingSync(defaultDashboardPath, paths.dashboard);
  copyIfMissingSync(defaultDashboardSchemaPath, paths.dashboardSchema);
  copyIfMissingSync(defaultSoulPath, paths.soul);
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

function hasShellOperator(value: string) {
  return /(?:\n|&&|\|\||[;&|<>`]|\$\()/.test(value);
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

      CREATE TABLE IF NOT EXISTS pr_watches (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        repo_full_name TEXT NOT NULL,
        github_owner TEXT NOT NULL,
        github_name TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        desired_terminal_state TEXT NOT NULL,
        status TEXT NOT NULL,
        pr_state TEXT,
        title TEXT,
        url TEXT,
        merge_commit_sha TEXT,
        last_snapshot_json TEXT,
        last_outcome TEXT,
        last_checked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(repo_full_name, pr_number)
      );

      CREATE TABLE IF NOT EXISTS ref_watches (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        repo_full_name TEXT NOT NULL,
        github_owner TEXT NOT NULL,
        github_name TEXT NOT NULL,
        ref TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT,
        url TEXT,
        last_snapshot_json TEXT,
        last_outcome TEXT,
        last_checked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(repo_full_name, ref)
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        blueprint TEXT,
        enabled INTEGER NOT NULL,
        interval_seconds INTEGER NOT NULL,
        config_json TEXT,
        next_run_at TEXT,
        last_run_at TEXT,
        last_outcome TEXT,
        last_message TEXT,
        last_result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        level TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        source TEXT,
        source_id TEXT,
        data_json TEXT,
        read_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(scope, key)
      );

      CREATE TABLE IF NOT EXISTS memory_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        changed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workflow_summaries (
        id TEXT PRIMARY KEY,
        workflow TEXT NOT NULL,
        run_id TEXT,
        status TEXT NOT NULL,
        summary_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workflow_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT,
        workflow TEXT,
        event_type TEXT NOT NULL,
        event_index INTEGER,
        level TEXT,
        message TEXT NOT NULL,
        name TEXT,
        operation_kind TEXT,
        operation_id TEXT,
        duration_ms INTEGER,
        is_error INTEGER NOT NULL DEFAULT 0,
        summary_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_workflow_events_run
        ON workflow_events(run_id, event_index);

      CREATE INDEX IF NOT EXISTS idx_workflow_events_created
        ON workflow_events(created_at DESC);

      CREATE TABLE IF NOT EXISTS workflow_run_observations (
        run_id TEXT PRIMARY KEY,
        workflow TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        last_event_at TEXT NOT NULL,
        last_message TEXT NOT NULL,
        event_count INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER,
        is_error INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS neon_sessions (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL,
        activated_at TEXT NOT NULL,
        ended_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS execution_approvals (
        id TEXT PRIMARY KEY,
        command TEXT NOT NULL,
        backend TEXT NOT NULL,
        cwd TEXT,
        context TEXT NOT NULL,
        risk TEXT NOT NULL,
        policy_decision TEXT NOT NULL,
        status TEXT NOT NULL,
        approval_decision TEXT,
        approver_surface TEXT,
        session_id TEXT,
        request_context_json TEXT,
        result_json TEXT,
        exit_code INTEGER,
        stdout_preview TEXT,
        stderr_preview TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        executed_at TEXT,
        updated_at TEXT NOT NULL
      );
    `);

    ensureColumn(database, 'notifications', 'resolved_at', 'TEXT');
    ensureColumn(database, 'notifications', 'updated_at', 'TEXT');
    ensureColumn(
      database,
      'notifications',
      'occurrence_count',
      'INTEGER NOT NULL DEFAULT 1',
    );
    database
      .prepare(
        `
        UPDATE notifications
        SET updated_at = created_at
        WHERE updated_at IS NULL;
      `,
      )
      .run();
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_notifications_source_unresolved
        ON notifications(source, source_id, resolved_at);

      CREATE INDEX IF NOT EXISTS idx_notifications_attention
        ON notifications(resolved_at, read_at, level, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_memory_events_changed
        ON memory_events(changed_at DESC);

      CREATE INDEX IF NOT EXISTS idx_execution_approvals_status
        ON execution_approvals(status, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_execution_approvals_updated
        ON execution_approvals(updated_at DESC);
    `);
    reconcileExistingNotificationDuplicates(database);
    reconcileActiveNeonSessions(database);

    database
      .prepare(
        `
        INSERT INTO neon_sessions (
          id,
          label,
          agent_name,
          status,
          reason,
          created_at,
          activated_at,
          updated_at
        )
        SELECT
          'neondeck-main',
          'Primary',
          'display-assistant',
          'active',
          'initial-session',
          datetime('now'),
          datetime('now'),
          datetime('now')
        WHERE NOT EXISTS (
          SELECT 1
          FROM neon_sessions
          WHERE agent_name = 'display-assistant'
            AND status = 'active'
        );
      `,
      )
      .run();

    database
      .prepare(
        `
        INSERT INTO app_metadata (key, value, updated_at)
        VALUES ('schema_version', '5', datetime('now'))
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

function ensureColumn(
  database: DatabaseSync,
  table: string,
  column: string,
  definition: string,
) {
  const columns = database
    .prepare(`PRAGMA table_info(${table});`)
    .all() as Array<{ name?: unknown }>;
  if (columns.some((item) => item.name === column)) {
    return;
  }

  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
}

function reconcileExistingNotificationDuplicates(database: DatabaseSync) {
  const now = new Date().toISOString();
  const groups = database
    .prepare(
      `
      SELECT source, source_id, COUNT(*) AS count
      FROM notifications
      WHERE source IS NOT NULL
        AND source_id IS NOT NULL
        AND resolved_at IS NULL
      GROUP BY source, source_id
      HAVING COUNT(*) > 1;
    `,
    )
    .all() as Array<{
    source: string;
    source_id: string;
    count: number;
  }>;

  for (const group of groups) {
    const rows = database
      .prepare(
        `
        SELECT id
        FROM notifications
        WHERE source = ?
          AND source_id = ?
          AND resolved_at IS NULL
        ORDER BY updated_at DESC, created_at DESC;
      `,
      )
      .all(group.source, group.source_id) as Array<{ id: string }>;
    const [active, ...duplicates] = rows;
    if (!active || duplicates.length === 0) continue;

    database
      .prepare(
        `
        UPDATE notifications
        SET occurrence_count = MAX(occurrence_count, ?), updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(Number(group.count), now, active.id);

    const placeholders = duplicates.map(() => '?').join(', ');
    database
      .prepare(
        `
        UPDATE notifications
        SET resolved_at = ?, read_at = COALESCE(read_at, ?), updated_at = ?
        WHERE id IN (${placeholders});
      `,
      )
      .run(now, now, now, ...duplicates.map((row) => row.id));
  }
}

function reconcileActiveNeonSessions(database: DatabaseSync) {
  const now = new Date().toISOString();
  const active = database
    .prepare(
      `
      SELECT id
      FROM neon_sessions
      WHERE agent_name = 'display-assistant'
        AND status = 'active'
      ORDER BY activated_at DESC, created_at DESC;
    `,
    )
    .all() as Array<{ id: string }>;
  const [, ...duplicates] = active;
  if (duplicates.length === 0) return;

  const placeholders = duplicates.map(() => '?').join(', ');
  database
    .prepare(
      `
      UPDATE neon_sessions
      SET status = 'archived', ended_at = ?, updated_at = ?
      WHERE id IN (${placeholders});
    `,
    )
    .run(now, now, ...duplicates.map((session) => session.id));
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
  const config = parseSchema(dashboardConfigSchema, value, path);
  validateDashboardConfig(config, path);
  return config;
}

function validateDashboardConfig(config: DashboardConfig, path: string) {
  const regionIds = new Set<string>();

  for (const region of config.layout.regions) {
    if (regionIds.has(region.id)) {
      throw new ConfigValidationError(
        path,
        `Duplicate dashboard region id "${region.id}".`,
      );
    }
    regionIds.add(region.id);

    const columnEnd = region.column + region.columnSpan - 1;
    if (columnEnd > config.layout.columns) {
      throw new ConfigValidationError(
        path,
        `Dashboard region "${region.id}" exceeds layout column count ${config.layout.columns}.`,
      );
    }

    const rowEnd = region.row + region.rowSpan - 1;
    if (rowEnd > config.layout.rows) {
      throw new ConfigValidationError(
        path,
        `Dashboard region "${region.id}" exceeds layout row count ${config.layout.rows}.`,
      );
    }

    const tabIds = new Set<string>();
    for (const tab of region.tabs) {
      if (tabIds.has(tab.id)) {
        throw new ConfigValidationError(
          path,
          `Duplicate dashboard tab id "${tab.id}" in region "${region.id}".`,
        );
      }
      tabIds.add(tab.id);
    }

    if (region.defaultTab && !tabIds.has(region.defaultTab)) {
      throw new ConfigValidationError(
        path,
        `Dashboard region "${region.id}" defaultTab "${region.defaultTab}" does not match a tab id.`,
      );
    }
  }
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
