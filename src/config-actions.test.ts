import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addRepo,
  addSchedule,
  applyDashboardPreset,
  readConfig,
  readProviderConfig,
  reloadConfig,
  removeRepo,
  removeSchedule,
  updateRepo,
  updateAgentModels,
  updateExecutionPolicy,
  updateDashboardLayout,
  updateProviderConfig,
  updateSchedule,
  updateSkillRoots,
  validateConfig,
} from './config-actions';
import { subscribeConfigEvents, type ConfigChangeEvent } from './config-events';
import {
  parseAppConfig,
  parseDashboardConfig,
  parseRepoRegistry,
  parseScheduleConfig,
  runtimePaths,
} from './runtime-home';

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('config actions', () => {
  it('adds, updates, and removes a repo through validated config operations', async () => {
    const home = await tempDir('neondeck-home-');
    const repoPath = await tempGitRepo();
    const paths = runtimePaths(home);

    await writeFile(
      join(repoPath, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run' } }),
    );

    await expect(
      addRepo({ path: repoPath, productionTarget: 'cloudflare' }, paths),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      message: 'Added repository "neondeck".',
    });

    let repos = parseRepoRegistry(
      JSON.parse(await readFile(paths.repos, 'utf8')),
      paths.repos,
    ).repos;
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({
      id: 'neondeck',
      github: { owner: 'pandemicsyn', name: 'neondeck' },
      defaultBranch: 'main',
      productionTarget: 'cloudflare',
      packageScripts: { test: 'vitest run' },
    });

    await expect(
      updateRepo({ id: 'neondeck', defaultBranch: 'trunk' }, paths),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      message: 'Updated repository "neondeck".',
    });

    repos = parseRepoRegistry(
      JSON.parse(await readFile(paths.repos, 'utf8')),
      paths.repos,
    ).repos;
    expect(repos[0].defaultBranch).toBe('trunk');

    await expect(removeRepo({ id: 'neondeck' }, paths)).resolves.toMatchObject({
      ok: false,
      changed: false,
      requires: ['confirm'],
    });

    await expect(
      removeRepo({ id: 'neondeck', confirm: true }, paths),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      message: 'Removed repository "neondeck".',
    });
    repos = parseRepoRegistry(
      JSON.parse(await readFile(paths.repos, 'utf8')),
      paths.repos,
    ).repos;
    expect(repos).toEqual([]);
    expect(readHistory(paths.neondeckDatabase)).toMatchObject([
      { action: 'config_add_repo', target: 'neondeck' },
      { action: 'config_update_repo', target: 'neondeck' },
      { action: 'config_remove_repo', target: 'neondeck' },
    ]);
  });

  it('asks for required GitHub metadata when a git repo has no GitHub remote', async () => {
    const home = await tempDir('neondeck-home-');
    const repoPath = await tempGitRepo({ remote: false });
    const paths = runtimePaths(home);

    await expect(addRepo({ path: repoPath }, paths)).resolves.toMatchObject({
      ok: false,
      changed: false,
      requires: ['githubOwner', 'githubName'],
    });
  });

  it('returns structured failures for invalid repo paths', async () => {
    const home = await tempDir('neondeck-home-');
    const paths = runtimePaths(home);

    await expect(
      addRepo({ path: join(home, 'missing') }, paths),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      action: 'config_add_repo',
      message:
        'Repository path could not be added because it failed validation.',
    });
  });

  it('returns structured failures for empty repo action fields', async () => {
    const home = await tempDir('neondeck-home-');
    const repoPath = await tempGitRepo();
    const paths = runtimePaths(home);

    await expect(
      addRepo({ path: repoPath, id: '' }, paths),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      action: 'config_add_repo',
      message: 'Invalid action input.',
    });

    await expect(
      updateRepo({ id: '', defaultBranch: 'main' }, paths),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      action: 'config_update_repo',
      message: 'Invalid action input.',
    });
  });

  it('updates skill roots through validated config history', async () => {
    const home = await tempDir('neondeck-home-');
    const paths = runtimePaths(home);
    const skillRoot = join(home, 'skills-extra');

    await expect(
      updateSkillRoots({ skillRoots: [skillRoot, skillRoot] }, paths),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      message:
        'Updated runtime skill roots. Start a new session for active agents to load changed skills.',
    });

    const config = parseAppConfig(
      JSON.parse(await readFile(paths.config, 'utf8')),
      paths.config,
    );
    expect(config.skillRoots).toEqual([skillRoot]);
    expect(readHistory(paths.neondeckDatabase)).toMatchObject([
      { action: 'config_update_skill_roots', target: 'skillRoots' },
    ]);
  });

  it('adds, updates, and removes schedules through validated config operations', async () => {
    const home = await tempDir('neondeck-home-');
    const paths = runtimePaths(home);

    await expect(
      addSchedule(
        {
          id: 'morning',
          type: 'morning-briefing',
          preset: 'weekday-morning',
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      message: 'Added schedule "morning".',
    });

    await expect(
      updateSchedule({ id: 'morning', enabled: false }, paths),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      message: 'Updated schedule "morning".',
    });

    let schedules = parseScheduleConfig(
      JSON.parse(await readFile(paths.schedules, 'utf8')),
      paths.schedules,
    ).schedules;
    expect(schedules).toMatchObject([
      { id: 'morning', type: 'morning-briefing', enabled: false },
    ]);

    await expect(
      removeSchedule({ id: 'morning' }, paths),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      requires: ['confirm'],
    });

    await expect(
      removeSchedule({ id: 'morning', confirm: true }, paths),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      message: 'Removed schedule "morning".',
    });

    schedules = parseScheduleConfig(
      JSON.parse(await readFile(paths.schedules, 'utf8')),
      paths.schedules,
    ).schedules;
    expect(schedules).toEqual([]);
    expect(readHistory(paths.neondeckDatabase)).toMatchObject([
      { action: 'config_add_schedule', target: 'morning' },
      { action: 'config_update_schedule', target: 'morning' },
      { action: 'config_remove_schedule', target: 'morning' },
    ]);
  });

  it('updates agent, utility, and subagent model config through a typed action', async () => {
    const home = await tempDir('neondeck-home-');
    const paths = runtimePaths(home);

    await expect(
      updateAgentModels(
        {
          displayAssistant: 'kilocode/kilo/main',
          utility: 'kilocode/kilo/utility',
          utilityThinkingLevel: 'low',
          subagents: {
            default: 'kilocode/kilo/subagent',
            ciInvestigator: 'kilocode/kilo/ci',
          },
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      action: 'config_update_agent_models',
      message:
        'Updated agent model configuration. Start a new session or restart the server for active agents to pick up the change.',
      data: {
        appliesAfter: 'new-session-or-server-restart',
      },
    });

    let config = parseAppConfig(
      JSON.parse(await readFile(paths.config, 'utf8')),
      paths.config,
    );
    expect(config.models).toEqual({
      displayAssistant: 'kilocode/kilo/main',
      utility: 'kilocode/kilo/utility',
      utilityThinkingLevel: 'low',
      subagents: {
        default: 'kilocode/kilo/subagent',
        ciInvestigator: 'kilocode/kilo/ci',
      },
    });

    await expect(
      updateAgentModels(
        {
          subagents: {
            repoResearcher: 'kilocode/kilo/repo',
          },
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
    });

    config = parseAppConfig(
      JSON.parse(await readFile(paths.config, 'utf8')),
      paths.config,
    );
    expect(config.models).toEqual({
      displayAssistant: 'kilocode/kilo/main',
      utility: 'kilocode/kilo/utility',
      utilityThinkingLevel: 'low',
      subagents: {
        default: 'kilocode/kilo/subagent',
        repoResearcher: 'kilocode/kilo/repo',
        ciInvestigator: 'kilocode/kilo/ci',
      },
    });
    expect(readHistory(paths.neondeckDatabase)).toMatchObject([
      { action: 'config_update_agent_models', target: 'models' },
      { action: 'config_update_agent_models', target: 'models' },
    ]);
  });

  it('clears utility model config through the typed action', async () => {
    const home = await tempDir('neondeck-home-');
    const paths = runtimePaths(home);

    await updateAgentModels(
      {
        displayAssistant: 'kilocode/kilo/main',
        utility: 'kilocode/kilo/utility',
      },
      paths,
    );
    await expect(
      updateAgentModels({ utility: null }, paths),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      action: 'config_update_agent_models',
    });

    const config = parseAppConfig(
      JSON.parse(await readFile(paths.config, 'utf8')),
      paths.config,
    );
    expect(config.models).toEqual({
      displayAssistant: 'kilocode/kilo/main',
    });
  });

  it('emits config events for writes and explicit reloads', async () => {
    const home = await tempDir('neondeck-home-');
    const paths = runtimePaths(home);
    const events: ConfigChangeEvent[] = [];
    const unsubscribe = subscribeConfigEvents((event) => {
      if (event.home === paths.home) events.push(event);
    });

    try {
      await updateAgentModels(
        { displayAssistant: 'kilocode/kilo/evented' },
        paths,
      );
      await reloadConfig(paths);
    } finally {
      unsubscribe();
    }

    expect(events).toMatchObject([
      {
        action: 'config_update_agent_models',
        changed: true,
        files: [paths.config],
        target: 'models',
      },
      {
        action: 'config_reload',
        changed: false,
        files: [paths.config, paths.repos, paths.dashboard, paths.schedules],
        target: 'all',
      },
    ]);
    expect(events[0]?.id).toBe('1');
  });

  it('updates dashboard layout through presets and validated layout input', async () => {
    const home = await tempDir('neondeck-home-');
    const paths = runtimePaths(home);

    await expect(
      applyDashboardPreset({ preset: 'classic' }, paths),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      action: 'config_apply_dashboard_preset',
      message: 'Applied dashboard preset "classic".',
    });

    let dashboard = parseDashboardConfig(
      JSON.parse(await readFile(paths.dashboard, 'utf8')),
      paths.dashboard,
    );
    expect(dashboard.statusline).toMatchObject({
      position: 'top',
      pluginId: 'host-metrics',
    });
    expect(dashboard.layout.regions).toHaveLength(2);
    expect(dashboard.layout.regions[0].tabs).toHaveLength(1);
    expect(dashboard.layout.regions[1]).toMatchObject({
      id: 'neon',
      defaultTab: 'chat',
    });

    const next = parseDashboardConfig(
      {
        ...dashboard,
        statusline: {
          position: 'bottom',
          pluginId: 'host-metrics',
          config: {},
        },
      },
      paths.dashboard,
    );
    await expect(updateDashboardLayout(next, paths)).resolves.toMatchObject({
      ok: true,
      changed: true,
      action: 'config_update_dashboard_layout',
      message: 'Updated dashboard layout.',
    });

    dashboard = parseDashboardConfig(
      JSON.parse(await readFile(paths.dashboard, 'utf8')),
      paths.dashboard,
    );
    expect(dashboard.statusline?.position).toBe('bottom');
    expect(readHistory(paths.neondeckDatabase)).toMatchObject([
      { action: 'config_apply_dashboard_preset', target: 'classic' },
      { action: 'config_update_dashboard_layout', target: 'layout' },
    ]);
  });

  it('can apply a dashboard preset over an invalid existing dashboard file', async () => {
    const home = await tempDir('neondeck-home-');
    const paths = runtimePaths(home);
    await writeFile(paths.dashboard, '{ "theme": "dark" }\n');

    await expect(
      applyDashboardPreset(
        { preset: 'cockpit', statuslinePosition: 'bottom' },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      action: 'config_apply_dashboard_preset',
    });

    const dashboard = parseDashboardConfig(
      JSON.parse(await readFile(paths.dashboard, 'utf8')),
      paths.dashboard,
    );
    expect(dashboard.statusline?.position).toBe('bottom');
    expect(dashboard.layout.regions[1].tabs.map((tab) => tab.id)).toEqual([
      'chat',
      'briefing',
      'memory',
      'runtime',
      'workflows',
      'subagents',
    ]);
  });

  it('returns structured failures and no-ops for agent model updates', async () => {
    const home = await tempDir('neondeck-home-');
    const paths = runtimePaths(home);

    await expect(updateAgentModels({}, paths)).resolves.toMatchObject({
      ok: false,
      changed: false,
      action: 'config_update_agent_models',
      requires: ['model'],
    });

    await expect(
      updateAgentModels({ displayAssistant: '' }, paths),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      action: 'config_update_agent_models',
      message: 'Invalid action input.',
    });

    await expect(
      updateAgentModels({ displayAssistant: 'ollama/llama3.1' }, paths),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      action: 'config_update_agent_models',
      message: 'Invalid action input.',
    });

    await expect(
      updateAgentModels({ displayAssistant: 'kilo-auto' }, paths),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      action: 'config_update_agent_models',
      message: 'Invalid action input.',
    });

    await expect(
      updateAgentModels(
        { displayAssistant: 'kilocode/kilo-auto/balanced' },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
    });
    await expect(
      updateAgentModels(
        { displayAssistant: 'kilocode/kilo-auto/balanced' },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: false,
      message:
        'Agent model configuration already matched the requested values.',
    });
    expect(readHistory(paths.neondeckDatabase)).toMatchObject([
      { action: 'config_update_agent_models', target: 'models' },
    ]);
  });

  it('reads and updates allowlisted provider config through env refs only', async () => {
    const home = await tempDir('neondeck-home-');
    const paths = runtimePaths(home);

    await expect(
      readProviderConfig(paths, { KILO_API_KEY: 'legacy' }),
    ).resolves.toMatchObject({
      ok: true,
      changed: false,
      action: 'config_read_providers',
      data: {
        providers: {
          kilocode: {
            enabled: true,
            apiKeyEnv: 'KILO_API_KEY',
            organizationIdEnv: null,
          },
        },
      },
    });

    await expect(
      updateProviderConfig(
        {
          provider: 'kilocode',
          enabled: true,
          apiKeyEnv: 'NEONDECK_KILO_KEY',
          organizationIdEnv: 'NEONDECK_KILO_ORG',
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      action: 'config_update_provider',
      message:
        'Updated provider configuration. Restart the server for provider registration changes to take effect.',
      data: {
        appliesAfter: 'server-restart',
      },
    });

    let config = parseAppConfig(
      JSON.parse(await readFile(paths.config, 'utf8')),
      paths.config,
    );
    expect(config.providers).toEqual({
      kilocode: {
        enabled: true,
        apiKeyEnv: 'NEONDECK_KILO_KEY',
        organizationIdEnv: 'NEONDECK_KILO_ORG',
      },
    });

    await expect(
      updateProviderConfig(
        {
          provider: 'kilocode',
          enabled: false,
          organizationIdEnv: null,
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      data: {
        providers: {
          kilocode: {
            enabled: false,
            apiKeyEnv: 'NEONDECK_KILO_KEY',
            organizationIdEnv: null,
          },
        },
      },
    });

    config = parseAppConfig(
      JSON.parse(await readFile(paths.config, 'utf8')),
      paths.config,
    );
    expect(config.providers).toEqual({
      kilocode: {
        enabled: false,
        apiKeyEnv: 'NEONDECK_KILO_KEY',
      },
    });

    await expect(
      updateProviderConfig(
        {
          provider: 'openai',
          enabled: true,
          apiKeyEnv: 'NEONDECK_OPENAI_KEY',
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      data: {
        providers: {
          kilocode: {
            enabled: false,
            apiKeyEnv: 'NEONDECK_KILO_KEY',
          },
          openai: {
            enabled: true,
            apiKeyEnv: 'NEONDECK_OPENAI_KEY',
          },
        },
      },
    });

    await expect(
      updateProviderConfig(
        {
          provider: 'anthropic',
          organizationIdEnv: 'ANTHROPIC_ORG',
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      message: 'anthropic provider does not support organizationIdEnv.',
    });

    config = parseAppConfig(
      JSON.parse(await readFile(paths.config, 'utf8')),
      paths.config,
    );
    expect(config.providers).toEqual({
      kilocode: {
        enabled: false,
        apiKeyEnv: 'NEONDECK_KILO_KEY',
      },
      openai: {
        enabled: true,
        apiKeyEnv: 'NEONDECK_OPENAI_KEY',
      },
    });
    expect(readHistory(paths.neondeckDatabase)).toMatchObject([
      { action: 'config_update_provider', target: 'providers.kilocode' },
      { action: 'config_update_provider', target: 'providers.kilocode' },
      { action: 'config_update_provider', target: 'providers.openai' },
    ]);
  });

  it('rejects unsafe provider config shapes and raw secret-looking values', async () => {
    const home = await tempDir('neondeck-home-');
    const paths = runtimePaths(home);

    await expect(
      updateProviderConfig({ provider: 'kilocode' }, paths),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      action: 'config_update_provider',
      requires: ['enabled', 'apiKeyEnv', 'organizationIdEnv'],
    });

    await expect(
      updateProviderConfig(
        { provider: 'kilocode', apiKeyEnv: 'sk-live-secret' },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      action: 'config_update_provider',
      message: 'Invalid action input.',
    });

    await expect(
      updateProviderConfig(
        { provider: 'kilocode', apiKeyEnv: 'lowercase_secret' },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      action: 'config_update_provider',
      message: 'Invalid action input.',
    });

    expect(readHistory(paths.neondeckDatabase)).toEqual([]);
  });

  it('updates execution approval policy through audited config', async () => {
    const home = await tempDir('neondeck-home-');
    const paths = runtimePaths(home);

    await expect(
      updateExecutionPolicy(
        {
          defaultBackend: 'exe.dev',
          enabledBackends: ['local', 'exe.dev'],
          unattended: 'allow-preapproved',
          preapprovedCommands: [
            {
              id: 'test',
              command: 'npm test',
              match: 'exact',
              backends: ['exe.dev'],
            },
          ],
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      action: 'config_update_execution_policy',
      data: {
        execution: {
          defaultBackend: 'exe.dev',
          enabledBackends: ['local', 'exe.dev'],
        },
        policy: {
          defaultBackend: 'exe.dev',
          enabledBackends: ['local', 'exe.dev'],
        },
      },
    });

    const config = parseAppConfig(
      JSON.parse(await readFile(paths.config, 'utf8')),
      paths.config,
    );
    expect(config.execution).toMatchObject({
      defaultBackend: 'exe.dev',
      enabledBackends: ['local', 'exe.dev'],
      unattended: 'allow-preapproved',
      preapprovedCommands: [
        {
          id: 'test',
          command: 'npm test',
          match: 'exact',
          backends: ['exe.dev'],
        },
      ],
    });
    expect(readHistory(paths.neondeckDatabase)).toMatchObject([
      { action: 'config_update_execution_policy', target: 'execution' },
    ]);

    await expect(
      updateExecutionPolicy(
        {
          preapprovedCommands: [
            {
              command: 'npm test && rm -rf /tmp/nope',
            },
          ],
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      action: 'config_update_execution_policy',
      message: 'Invalid action input.',
    });
  });

  it('returns structured failures for empty schedule action fields', async () => {
    const home = await tempDir('neondeck-home-');
    const paths = runtimePaths(home);

    await expect(
      addSchedule({ id: '', type: '' }, paths),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      action: 'config_add_schedule',
      message: 'Invalid action input.',
    });

    await expect(
      updateSchedule({ id: '', cron: '' }, paths),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      action: 'config_update_schedule',
      message: 'Invalid action input.',
    });

    await expect(
      removeSchedule({ id: '', confirm: true }, paths),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      action: 'config_remove_schedule',
      message: 'Invalid action input.',
    });
  });

  it('reads and validates config through explicit action boundaries', async () => {
    const home = await tempDir('neondeck-home-');
    const paths = runtimePaths(home);

    await expect(readConfig({ target: 'repos' }, paths)).resolves.toMatchObject(
      {
        ok: true,
        changed: false,
        data: { repos: { repos: [] } },
      },
    );

    await writeFile(paths.schedules, '{ "schedules": [{ "id": "" }] }\n');

    await expect(
      validateConfig({ target: 'schedules' }, paths),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      message: 'Invalid schedules config.',
    });
    expect(existsSync(paths.neondeckDatabase)).toBe(true);
    expect(existsSync(paths.flueDatabase)).toBe(true);
  });
});

async function tempDir(prefix: string) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(path);
  return path;
}

async function tempGitRepo(options: { remote?: boolean } = {}) {
  const path = await tempDir('neondeck-repo-');
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: path });

  if (options.remote !== false) {
    await execFileAsync(
      'git',
      ['remote', 'add', 'origin', 'git@github.com:pandemicsyn/neondeck.git'],
      { cwd: path },
    );
  }

  return path;
}

function readHistory(path: string) {
  const database = new DatabaseSync(path);

  try {
    return database
      .prepare(
        `
        SELECT action, target
        FROM config_history
        ORDER BY id ASC;
      `,
      )
      .all() as Array<{ action: string; target: string | null }>;
  } finally {
    database.close();
  }
}
