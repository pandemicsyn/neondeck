import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { readAgentModelSelectionSync } from './agent-config';
import {
  ConfigValidationError,
  ensureRuntimeHome,
  parseAppConfig,
  parseDashboardConfig,
  parseRepoRegistry,
  parseScheduleConfig,
  readRuntimeJson,
  resolveRuntimeHome,
  runtimePaths,
} from './runtime-home';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('runtime home', () => {
  it('resolves NEONDECK_HOME before XDG and HOME defaults', () => {
    expect(
      resolveRuntimeHome({
        NEONDECK_HOME: '~/deck',
        XDG_CONFIG_HOME: '/tmp/xdg',
        HOME: '/Users/tester',
      }),
    ).toBe('/Users/tester/deck');
  });

  it('resolves XDG_CONFIG_HOME when NEONDECK_HOME is not set', () => {
    expect(
      resolveRuntimeHome({
        XDG_CONFIG_HOME: '/tmp/xdg',
        HOME: '/Users/tester',
      }),
    ).toBe('/tmp/xdg/neondeck');
  });

  it('falls back to ~/.config/neondeck', () => {
    expect(resolveRuntimeHome({ HOME: '/Users/tester' })).toBe(
      '/Users/tester/.config/neondeck',
    );
  });

  it('creates the initial runtime layout without overwriting user files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neondeck-home-'));
    tempRoots.push(root);
    const paths = runtimePaths(root);

    await ensureRuntimeHome(paths);
    await writeFile(
      paths.repos,
      JSON.stringify({
        repos: [
          {
            id: 'mine',
            github: { owner: 'pandemicsyn', name: 'mine' },
            path: '/tmp/mine',
            defaultBranch: 'main',
          },
        ],
      }),
    );
    await ensureRuntimeHome(paths);

    await expect(
      readRuntimeJson(paths.config, parseAppConfig),
    ).resolves.toEqual({
      version: 1,
    });
    await expect(
      readRuntimeJson(paths.repos, parseRepoRegistry),
    ).resolves.toEqual({
      repos: [
        {
          id: 'mine',
          github: { owner: 'pandemicsyn', name: 'mine' },
          path: '/tmp/mine',
          defaultBranch: 'main',
        },
      ],
    });
    await expect(
      readRuntimeJson(paths.schedules, parseScheduleConfig),
    ).resolves.toEqual({
      schedules: [],
    });

    expect(existsSync(paths.dashboard)).toBe(true);
    expect(existsSync(paths.dashboardSchema)).toBe(true);
    expect(existsSync(paths.env)).toBe(true);
    expect(existsSync(paths.soul)).toBe(true);
    expect(existsSync(paths.data)).toBe(true);
    expect(existsSync(paths.neondeckDatabase)).toBe(true);
    expect(existsSync(paths.flueDatabase)).toBe(true);
    expect(existsSync(paths.skills)).toBe(true);

    await expect(
      readRuntimeJson(paths.dashboard, parseDashboardConfig),
    ).resolves.toMatchObject({
      display: { width: 2560, height: 720 },
      statusline: { position: 'top', pluginId: 'host-metrics' },
      layout: { columns: 12, rows: 5 },
    });

    await expect(
      readFile(join(paths.skills, 'neondeck', 'SKILL.md'), 'utf8'),
    ).rejects.toThrow('no such file or directory');
  });

  it('rejects malformed runtime config with a controlled validation error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neondeck-home-'));
    tempRoots.push(root);
    const paths = runtimePaths(root);

    await ensureRuntimeHome(paths);
    await writeFile(paths.dashboard, '{ "layout": { "regions": [] } }\n');

    await expect(
      readRuntimeJson(paths.dashboard, parseDashboardConfig),
    ).rejects.toThrow(ConfigValidationError);
  });

  it('accepts agent and subagent model config from runtime config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neondeck-home-'));
    tempRoots.push(root);
    const paths = runtimePaths(root);

    await ensureRuntimeHome(paths);
    await writeFile(
      paths.config,
      JSON.stringify(
        {
          version: 1,
          models: {
            default: 'kilocode/kilo/auto',
            displayAssistant: 'kilocode/kilo/main',
            subagents: {
              default: 'kilocode/kilo/subagent',
              repoResearcher: 'kilocode/kilo/repo',
              ciInvestigator: 'kilocode/kilo/ci',
              releaseReviewer: 'kilocode/kilo/release',
            },
          },
        },
        null,
        2,
      ),
    );

    await expect(
      readRuntimeJson(paths.config, parseAppConfig),
    ).resolves.toMatchObject({
      models: {
        displayAssistant: 'kilocode/kilo/main',
        subagents: {
          repoResearcher: 'kilocode/kilo/repo',
          ciInvestigator: 'kilocode/kilo/ci',
          releaseReviewer: 'kilocode/kilo/release',
        },
      },
    });
    expect(readAgentModelSelectionSync(paths)).toEqual({
      displayAssistant: 'kilocode/kilo/main',
      subagents: {
        repoResearcher: 'kilocode/kilo/repo',
        ciInvestigator: 'kilocode/kilo/ci',
        releaseReviewer: 'kilocode/kilo/release',
      },
    });
  });

  it('accepts allowlisted provider config from runtime config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neondeck-home-'));
    tempRoots.push(root);
    const paths = runtimePaths(root);

    await ensureRuntimeHome(paths);
    await writeFile(
      paths.config,
      JSON.stringify(
        {
          version: 1,
          providers: {
            kilocode: {
              enabled: true,
              apiKeyEnv: 'NEONDECK_KILO_KEY',
              organizationIdEnv: 'NEONDECK_KILO_ORG',
            },
          },
        },
        null,
        2,
      ),
    );

    await expect(
      readRuntimeJson(paths.config, parseAppConfig),
    ).resolves.toMatchObject({
      providers: {
        kilocode: {
          enabled: true,
          apiKeyEnv: 'NEONDECK_KILO_KEY',
          organizationIdEnv: 'NEONDECK_KILO_ORG',
        },
      },
    });

    await writeFile(
      paths.config,
      JSON.stringify(
        {
          version: 1,
          providers: {
            kilocode: {
              apiKeyEnv: 'sk-live-secret',
            },
          },
        },
        null,
        2,
      ),
    );

    await expect(readRuntimeJson(paths.config, parseAppConfig)).rejects.toThrow(
      ConfigValidationError,
    );

    await writeFile(
      paths.config,
      JSON.stringify(
        {
          version: 1,
          providers: {
            kilocode: {
              apiKeyEnv: 'NEONDECK_KILO_KEY',
              apiKey: 'raw-secret',
            },
          },
        },
        null,
        2,
      ),
    );

    await expect(readRuntimeJson(paths.config, parseAppConfig)).rejects.toThrow(
      ConfigValidationError,
    );

    await writeFile(
      paths.config,
      JSON.stringify(
        {
          version: 1,
          providers: {
            openai: {
              apiKeyEnv: 'OPENAI_API_KEY',
            },
          },
        },
        null,
        2,
      ),
    );

    await expect(readRuntimeJson(paths.config, parseAppConfig)).rejects.toThrow(
      ConfigValidationError,
    );
  });

  it('accepts exe.dev execution adapter env references from runtime config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neondeck-home-'));
    tempRoots.push(root);
    const paths = runtimePaths(root);

    await ensureRuntimeHome(paths);
    await writeFile(
      paths.config,
      JSON.stringify(
        {
          version: 1,
          execution: {
            defaultBackend: 'exe.dev',
            enabledBackends: ['local', 'exe.dev'],
            exeDev: {
              lifecycle: 'existing-vm',
              vmHostEnv: 'EXE_VM_HOST',
              sshKeyEnv: 'EXE_SSH_KEY',
              apiTokenEnv: 'EXE_API_TOKEN',
            },
          },
        },
        null,
        2,
      ),
    );

    await expect(
      readRuntimeJson(paths.config, parseAppConfig),
    ).resolves.toMatchObject({
      execution: {
        defaultBackend: 'exe.dev',
        enabledBackends: ['local', 'exe.dev'],
        exeDev: {
          lifecycle: 'existing-vm',
          vmHostEnv: 'EXE_VM_HOST',
          sshKeyEnv: 'EXE_SSH_KEY',
          apiTokenEnv: 'EXE_API_TOKEN',
        },
      },
    });
  });

  it('accepts bounded execution approval config and rejects shell-operator preapprovals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neondeck-home-'));
    tempRoots.push(root);
    const paths = runtimePaths(root);

    await ensureRuntimeHome(paths);
    await writeFile(
      paths.config,
      JSON.stringify(
        {
          version: 1,
          execution: {
            defaultBackend: 'exe.dev',
            enabledBackends: ['local', 'exe.dev'],
            approvalMode: 'manual',
            unattended: 'allow-preapproved',
            preapprovedCommands: [
              {
                id: 'tests',
                command: 'npm test',
                match: 'exact',
                backends: ['exe.dev'],
              },
            ],
          },
        },
        null,
        2,
      ),
    );

    await expect(
      readRuntimeJson(paths.config, parseAppConfig),
    ).resolves.toMatchObject({
      execution: {
        defaultBackend: 'exe.dev',
        enabledBackends: ['local', 'exe.dev'],
        preapprovedCommands: [
          {
            id: 'tests',
            command: 'npm test',
            backends: ['exe.dev'],
          },
        ],
      },
    });

    await writeFile(
      paths.config,
      JSON.stringify(
        {
          version: 1,
          execution: {
            preapprovedCommands: [
              {
                command: 'npm test && rm -rf /tmp/nope',
              },
            ],
          },
        },
        null,
        2,
      ),
    );

    await expect(readRuntimeJson(paths.config, parseAppConfig)).rejects.toThrow(
      ConfigValidationError,
    );
  });

  it('does not validate unrelated mutable config during bootstrap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neondeck-home-'));
    tempRoots.push(root);
    const paths = runtimePaths(root);

    await writeFile(paths.dashboard, '{ "theme": "neon" }\n');

    await expect(ensureRuntimeHome(paths)).resolves.toBeUndefined();
    expect(existsSync(paths.neondeckDatabase)).toBe(true);
    expect(existsSync(paths.flueDatabase)).toBe(true);

    await expect(
      readRuntimeJson(paths.dashboard, parseDashboardConfig),
    ).rejects.toThrow(ConfigValidationError);
  });

  it('reconciles existing duplicate unresolved notifications during bootstrap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neondeck-home-'));
    tempRoots.push(root);
    const paths = runtimePaths(root);

    await ensureRuntimeHome(paths);
    const database = new DatabaseSync(paths.neondeckDatabase);
    try {
      const insert = database.prepare(
        `
        INSERT INTO notifications (
          id,
          level,
          title,
          message,
          source,
          source_id,
          created_at,
          updated_at
        )
        VALUES (?, 'attention', ?, ?, 'watch-pr', 'repo#1', ?, ?);
      `,
      );
      insert.run(
        'old',
        'Old',
        'Old failure.',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
      );
      insert.run(
        'new',
        'New',
        'New failure.',
        '2026-01-02T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
      );
    } finally {
      database.close();
    }

    await ensureRuntimeHome(paths);

    const result = new DatabaseSync(paths.neondeckDatabase);
    try {
      expect(
        result
          .prepare(
            `
            SELECT id, resolved_at, occurrence_count
            FROM notifications
            WHERE source = 'watch-pr'
              AND source_id = 'repo#1'
            ORDER BY resolved_at IS NULL DESC, id DESC;
          `,
          )
          .all(),
      ).toEqual([
        {
          id: 'new',
          resolved_at: null,
          occurrence_count: 2,
        },
        {
          id: 'old',
          resolved_at: expect.any(String),
          occurrence_count: 1,
        },
      ]);
    } finally {
      result.close();
    }
  });

  it('enforces the dashboard frontend config contract', () => {
    const dashboardConfig = () => ({
      display: { width: 2560, height: 720 },
      theme: 'dark',
      layout: {
        columns: 12,
        rows: 5,
        regions: [
          {
            id: 'neon',
            title: 'Neon',
            column: 1,
            row: 1,
            columnSpan: 12,
            rowSpan: 5,
            defaultTab: 'chat',
            tabs: [
              {
                id: 'chat',
                title: 'Chat',
                pluginId: 'flue-chat',
                config: {},
              },
            ],
          },
        ],
      },
    });

    expect(() =>
      parseDashboardConfig(
        {
          display: { width: 2560, height: 720 },
          theme: 'neon',
          layout: { columns: 12, rows: 6, regions: [] },
        },
        'dashboard.json',
      ),
    ).toThrow(ConfigValidationError);

    expect(() =>
      parseDashboardConfig(
        {
          display: { width: 2560, height: 720 },
          theme: 'dark',
          layout: {
            columns: 12,
            rows: 6,
            regions: [
              {
                id: 'chat',
                title: 'Chat',
                column: -1,
                row: 1.5,
                columnSpan: 8,
                rowSpan: 5,
                tabs: [
                  {
                    id: 'chat',
                    title: 'Chat',
                    pluginId: 'flue-chat',
                    config: {},
                  },
                ],
              },
            ],
          },
        },
        'dashboard.json',
      ),
    ).toThrow(ConfigValidationError);

    expect(() =>
      parseDashboardConfig(
        {
          display: { width: 2560, height: 720 },
          theme: 'dark',
          layout: {
            columns: 12,
            rows: 5,
            regions: [
              {
                id: 'neon',
                title: 'Neon',
                column: 1,
                row: 1,
                columnSpan: 12,
                rowSpan: 5,
                tabs: [],
              },
            ],
          },
        },
        'dashboard.json',
      ),
    ).toThrow(ConfigValidationError);

    expect(() => {
      const config = dashboardConfig();
      config.layout.regions[0].column = 10;
      config.layout.regions[0].columnSpan = 4;
      parseDashboardConfig(config, 'dashboard.json');
    }).toThrow(ConfigValidationError);

    expect(() => {
      const config = dashboardConfig();
      config.layout.regions[0].row = 4;
      config.layout.regions[0].rowSpan = 3;
      parseDashboardConfig(config, 'dashboard.json');
    }).toThrow(ConfigValidationError);

    expect(() => {
      const config = dashboardConfig();
      config.layout.regions.push({
        ...config.layout.regions[0],
        title: 'Neon Duplicate',
      });
      parseDashboardConfig(config, 'dashboard.json');
    }).toThrow(ConfigValidationError);

    expect(() => {
      const config = dashboardConfig();
      config.layout.regions[0].tabs.push({
        id: 'chat',
        title: 'Chat Duplicate',
        pluginId: 'flue-chat',
        config: {},
      });
      parseDashboardConfig(config, 'dashboard.json');
    }).toThrow(ConfigValidationError);

    expect(() => {
      const config = dashboardConfig();
      config.layout.regions[0].defaultTab = 'missing';
      parseDashboardConfig(config, 'dashboard.json');
    }).toThrow(ConfigValidationError);
  });
});
