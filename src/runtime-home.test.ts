import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
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
    expect(existsSync(paths.soul)).toBe(true);
    expect(existsSync(paths.data)).toBe(true);
    expect(existsSync(paths.neondeckDatabase)).toBe(true);
    expect(existsSync(paths.flueDatabase)).toBe(true);
    expect(existsSync(paths.skills)).toBe(true);

    await expect(
      readRuntimeJson(paths.dashboard, parseDashboardConfig),
    ).resolves.toMatchObject({
      display: { width: 2560, height: 720 },
      layout: { columns: 12, rows: 6 },
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

  it('enforces the dashboard frontend config contract', () => {
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
                pluginId: 'flue-chat',
                column: -1,
                row: 1.5,
                columnSpan: 8,
                rowSpan: 5,
                config: {},
              },
            ],
          },
        },
        'dashboard.json',
      ),
    ).toThrow(ConfigValidationError);
  });
});
