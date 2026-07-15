import { readFile } from 'node:fs/promises';
import { parseActionInput, okResult, errorMessage } from '../result';
import { recordConfigChange } from '../history';
import { writeJson } from '../files';
import { dashboardPresetSchema, type ConfigActionResult } from '../schemas';
import {
  type DashboardConfig,
  dashboardSchemaVersion,
  ensureRuntimeHome,
  dashboardConfigSchema,
  parseDashboardConfig,
  runtimePaths,
  type RuntimePaths,
} from '../../../runtime-home';

export async function updateDashboardLayout(
  rawInput: unknown,
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    dashboardConfigSchema,
    rawInput,
    'config_update_dashboard_layout',
    paths,
    [paths.dashboard],
  );
  if (!parsed.ok) return parsed.result;

  const current = await readDashboardForHistory(paths);
  const next = parsed.input;
  const changed = JSON.stringify(current) !== JSON.stringify(next);

  if (changed) {
    await writeJson(paths.dashboard, next);
    recordConfigChange(paths, {
      action: 'config_update_dashboard_layout',
      file: paths.dashboard,
      target: 'layout',
      before: current,
      after: next,
    });
  }

  return okResult(
    'config_update_dashboard_layout',
    changed,
    paths,
    [paths.dashboard],
    {
      message: changed
        ? 'Updated dashboard layout.'
        : 'Dashboard layout already matched the requested value.',
      data: { dashboard: next },
    },
  );
}

export async function applyDashboardPreset(
  rawInput: unknown,
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    dashboardPresetSchema,
    rawInput,
    'config_apply_dashboard_preset',
    paths,
    [paths.dashboard],
  );
  if (!parsed.ok) return parsed.result;

  const current = await readDashboardForHistory(paths);
  const next = dashboardPresetConfig(
    parsed.input.preset,
    parsed.input.statuslinePosition ?? 'top',
  );
  const changed = JSON.stringify(current) !== JSON.stringify(next);

  if (changed) {
    await writeJson(paths.dashboard, next);
    recordConfigChange(paths, {
      action: 'config_apply_dashboard_preset',
      file: paths.dashboard,
      target: parsed.input.preset,
      before: current,
      after: next,
    });
  }

  return okResult(
    'config_apply_dashboard_preset',
    changed,
    paths,
    [paths.dashboard],
    {
      message: changed
        ? `Applied dashboard preset "${parsed.input.preset}".`
        : `Dashboard preset "${parsed.input.preset}" was already active.`,
      data: {
        preset: parsed.input.preset,
        dashboard: next,
      },
    },
  );
}

async function readDashboardForHistory(paths: RuntimePaths): Promise<unknown> {
  const source = await readFile(paths.dashboard, 'utf8').catch(() => undefined);
  if (!source) return null;

  try {
    return parseDashboardConfig(JSON.parse(source), paths.dashboard);
  } catch (error) {
    return {
      invalidDashboard: paths.dashboard,
      error: errorMessage(error),
    };
  }
}

function dashboardPresetConfig(
  preset: 'classic' | 'cockpit',
  statuslinePosition: 'top' | 'bottom',
): DashboardConfig {
  if (preset === 'classic') {
    return parseDashboardConfig(
      {
        $schema: './dashboard.schema.json',
        schemaVersion: dashboardSchemaVersion,
        display: { preset: 'xeneon-edge', width: 2560, height: 720 },
        appearance: { density: 'comfortable' },
        theme: 'dark',
        statusline: {
          position: statuslinePosition,
          pluginId: 'host-metrics',
          config: {},
        },
        layout: {
          mode: 'auto',
          columns: 12,
          rows: 5,
          regions: [
            {
              id: 'work',
              title: 'WORK',
              column: 1,
              row: 1,
              columnSpan: 4,
              rowSpan: 5,
              defaultTab: 'reviews',
              tabs: [
                reviewsTab(),
                {
                  id: 'github',
                  title: 'GITHUB',
                  pluginId: 'github-pr-list',
                  config: { limit: 12 },
                },
                reportsTab(),
              ],
            },
            {
              id: 'neon',
              title: 'NEON',
              column: 5,
              row: 1,
              columnSpan: 8,
              rowSpan: 5,
              defaultTab: 'chat',
              tabs: [chatTab()],
            },
          ],
        },
      },
      'dashboard:preset:classic',
    );
  }

  return parseDashboardConfig(
    {
      $schema: './dashboard.schema.json',
      schemaVersion: dashboardSchemaVersion,
      display: { preset: 'xeneon-edge', width: 2560, height: 720 },
      appearance: { density: 'comfortable' },
      theme: 'dark',
      statusline: {
        position: statuslinePosition,
        pluginId: 'host-metrics',
        config: {},
      },
      layout: {
        mode: 'auto',
        columns: 12,
        rows: 5,
        regions: [
          {
            id: 'work',
            title: 'WORK',
            column: 1,
            row: 1,
            columnSpan: 4,
            rowSpan: 5,
            defaultTab: 'reviews',
            tabs: [
              reviewsTab(),
              {
                id: 'github',
                title: 'GITHUB',
                pluginId: 'github-pr-list',
                config: { limit: 12 },
              },
              {
                id: 'watches',
                title: 'WATCHES',
                pluginId: 'active-watches',
                config: { limit: 8 },
              },
              reportsTab(),
            ],
          },
          {
            id: 'neon',
            title: 'NEON',
            column: 5,
            row: 1,
            columnSpan: 8,
            rowSpan: 5,
            defaultTab: 'chat',
            tabs: [
              chatTab(),
              {
                id: 'briefing',
                title: 'BRIEFING',
                pluginId: 'briefing-panel',
                config: { actionLimit: 4 },
              },
              {
                id: 'memory',
                title: 'MEMORY',
                pluginId: 'memory-panel',
                config: { limit: 5 },
              },
              {
                id: 'learning',
                title: 'LEARNING',
                pluginId: 'learning-operator',
                config: { limit: 16, refreshSeconds: 30 },
              },
              {
                id: 'runtime',
                title: 'RUNTIME',
                pluginId: 'runtime-overview',
                config: {
                  repoLimit: 5,
                  jobLimit: 5,
                  skillLimit: 5,
                  memoryLimit: 5,
                  workflowEventLimit: 6,
                },
              },
              {
                id: 'workflows',
                title: 'WORKFLOWS',
                pluginId: 'workflow-observability',
                config: {
                  eventLimit: 16,
                  refreshSeconds: 20,
                },
              },
              {
                id: 'subagents',
                title: 'SUBAGENTS',
                pluginId: 'subagent-summary',
                config: { eventLimit: 4 },
              },
            ],
          },
        ],
      },
    },
    'dashboard:preset:cockpit',
  );
}

function reportsTab() {
  return {
    id: 'reports',
    title: 'REPORTS',
    pluginId: 'reports-panel',
    config: { limit: 12, refreshSeconds: 60 },
  };
}

function reviewsTab() {
  return {
    id: 'reviews',
    title: 'REVIEWS',
    pluginId: 'reviews-panel',
    config: {},
  };
}

function chatTab() {
  return {
    id: 'chat',
    title: 'CHAT',
    pluginId: 'flue-chat',
    config: {
      agentName: 'display-assistant',
      sessions: [
        {
          id: 'neondeck-main',
          label: 'Primary',
          placeholder: 'Ask about your active work...',
        },
      ],
      quickCommands: [
        { label: 'Repo', command: '/repo-status' },
        { label: 'Queue', command: '/review-queue' },
        { label: 'Review PR', command: '/review-pr' },
        { label: 'CI', command: '/explain-ci' },
        { label: 'Fix CI', command: '/fix-ci' },
        { label: 'PR', command: '/summarize-pr' },
        { label: 'Draft', command: '/draft-pr-description' },
        { label: 'Prep', command: '/prepare-pr' },
        { label: 'Review', command: '/review-local' },
        { label: 'Memory', command: '/memory' },
        { label: 'Doctor', command: '/dev-doctor' },
      ],
    },
  };
}
