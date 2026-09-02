import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultOpenAiCodexModel } from '../model-defaults';
import { updateAgentModels } from '../modules/config';
import { readChatSession, readNeonSessionState } from '../modules/sessions';
import { ensureRuntimeHome, runtimePaths } from '../runtime-home';
import {
  configureGitIdentity,
  defaultProviderModel,
  exploreModelRecommendation,
  finalizeFreshInstallSession,
  formatOnboardingNextSteps,
  formatRuntimeSkillRootsNote,
  hasPackagedServerEntry,
  providerFromModel,
} from './onboarding';

const tempRoots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('onboarding session baseline', () => {
  it('rebaselines only an unused bootstrap session', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-07-24T12:00:00.000Z');
    const home = await mkdtemp(join(tmpdir(), 'neondeck-onboarding-'));
    tempRoots.push(home);
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);

    vi.setSystemTime('2026-07-24T12:00:01.000Z');
    await updateAgentModels({ displayAssistant: 'openai/gpt-5.5' }, paths);
    await expect(readNeonSessionState(paths)).resolves.toMatchObject({
      stale: true,
    });
    await expect(
      readChatSession(
        { id: 'neondeck-main', reason: 'status-inspection' },
        paths,
      ),
    ).resolves.toMatchObject({ ok: true, changed: false });

    vi.setSystemTime('2026-07-24T12:00:02.000Z');
    await finalizeFreshInstallSession(paths);
    await expect(readNeonSessionState(paths)).resolves.toMatchObject({
      activeSessionId: 'neondeck-main',
      stale: false,
      staleReasons: [],
    });

    vi.setSystemTime('2026-07-24T12:00:03.000Z');
    await updateAgentModels(
      { displayAssistant: 'anthropic/claude-sonnet-4-6' },
      paths,
    );
    await finalizeFreshInstallSession(paths);
    await expect(readNeonSessionState(paths)).resolves.toMatchObject({
      activeSessionId: 'neondeck-main',
      stale: true,
    });
  });

  it('rebaselines a bootstrap session materialized by a read-only command', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-07-24T12:00:00.000Z');
    const home = await mkdtemp(join(tmpdir(), 'neondeck-onboarding-'));
    tempRoots.push(home);
    const paths = runtimePaths(home);

    await readNeonSessionState(paths);
    vi.setSystemTime('2026-07-24T12:00:01.000Z');
    await updateAgentModels({ displayAssistant: 'openai/gpt-5.5' }, paths);
    await expect(readNeonSessionState(paths)).resolves.toMatchObject({
      stale: true,
    });

    vi.setSystemTime('2026-07-24T12:00:02.000Z');
    await finalizeFreshInstallSession(paths);
    await expect(readNeonSessionState(paths)).resolves.toMatchObject({
      activeSessionId: 'neondeck-main',
      stale: false,
      staleReasons: [],
    });
  });

  it('does not rebaseline an existing unused home without the onboarding marker', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-07-24T12:00:00.000Z');
    const home = await mkdtemp(join(tmpdir(), 'neondeck-onboarding-'));
    tempRoots.push(home);
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    const database = new DatabaseSync(paths.neondeckDatabase);
    try {
      database
        .prepare(
          `DELETE FROM chat_session_audit WHERE action = 'onboarding_pending';`,
        )
        .run();
    } finally {
      database.close();
    }

    vi.setSystemTime('2026-07-24T12:00:01.000Z');
    await updateAgentModels({ displayAssistant: 'openai/gpt-5.5' }, paths);
    await finalizeFreshInstallSession(paths);
    await expect(readNeonSessionState(paths)).resolves.toMatchObject({
      activeSessionId: 'neondeck-main',
      stale: true,
    });
  });
});

describe('Git identity onboarding', () => {
  it('accepts an existing global identity without prompting', async () => {
    const runGit = vi.fn<(args: string[]) => Promise<string>>(async (args) => {
      if (args.at(-1) === 'user.name') return 'syn\n';
      if (args.at(-1) === 'user.email') return 'syn@neonronin.sh\n';
      return 'git version 2.50.0\n';
    });
    const confirm = vi.fn<(options: unknown) => Promise<boolean>>();
    const success = vi.fn<(message: string) => void>();

    await expect(
      configureGitIdentity({
        persistedEnv: {},
        runGit,
        confirm,
        success,
      }),
    ).resolves.toEqual({
      status: 'ready',
      name: 'syn',
      email: 'syn@neonronin.sh',
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(success).toHaveBeenCalledWith(
      'Git commit identity is ready: syn <syn@neonronin.sh>',
    );
  });

  it('offers to configure a missing global identity and fails closed', async () => {
    const runGit = vi.fn<(args: string[]) => Promise<string>>(async (args) => {
      if (args[0] === '--version') return 'git version 2.50.0\n';
      if (args.includes('--get')) throw new Error('missing');
      return '';
    });
    const text = vi
      .fn<(options: unknown) => Promise<string>>()
      .mockResolvedValueOnce('syn')
      .mockResolvedValueOnce('syn@neonronin.sh');
    const warn = vi.fn<(message: string) => void>();
    const success = vi.fn<(message: string) => void>();

    await expect(
      configureGitIdentity({
        persistedEnv: {},
        runGit,
        confirm: vi
          .fn<(options: unknown) => Promise<boolean>>()
          .mockResolvedValue(true),
        text,
        warn,
        success,
      }),
    ).resolves.toEqual({
      status: 'configured',
      name: 'syn',
      email: 'syn@neonronin.sh',
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Autopilot commits may otherwise use'),
    );
    expect(runGit).toHaveBeenCalledWith([
      'config',
      '--global',
      '--replace-all',
      'user.name',
      'syn',
    ]);
    expect(runGit).toHaveBeenCalledWith([
      'config',
      '--global',
      '--replace-all',
      'user.email',
      'syn@neonronin.sh',
    ]);
    expect(runGit).toHaveBeenCalledWith([
      'config',
      '--global',
      '--replace-all',
      'user.useConfigOnly',
      'true',
    ]);
    expect(success).toHaveBeenCalledWith(
      'Configured global Git identity: syn <syn@neonronin.sh>',
    );
  });

  it('warns but leaves Git unchanged when configuration is declined', async () => {
    const runGit = vi.fn<(args: string[]) => Promise<string>>(async (args) => {
      if (args[0] === '--version') return 'git version 2.50.0\n';
      throw new Error('missing');
    });
    const warn = vi.fn<(message: string) => void>();

    await expect(
      configureGitIdentity({
        persistedEnv: {},
        runGit,
        confirm: vi
          .fn<(options: unknown) => Promise<boolean>>()
          .mockResolvedValue(false),
        warn,
      }),
    ).resolves.toEqual({ status: 'skipped', name: null, email: null });
    expect(runGit).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('does not treat temporary shell overrides as service-ready identity', async () => {
    vi.stubEnv('GIT_AUTHOR_NAME', 'Temporary Automation');
    vi.stubEnv('GIT_AUTHOR_EMAIL', 'temporary@example.test');
    vi.stubEnv('GIT_COMMITTER_NAME', 'Temporary Automation');
    vi.stubEnv('GIT_COMMITTER_EMAIL', 'temporary@example.test');
    const runGit = vi.fn<(args: string[]) => Promise<string>>(async (args) => {
      if (args[0] === '--version') return 'git version 2.50.0\n';
      throw new Error('missing');
    });
    const confirm = vi
      .fn<(options: unknown) => Promise<boolean>>()
      .mockResolvedValue(false);

    await expect(
      configureGitIdentity({
        persistedEnv: {},
        runGit,
        confirm,
        warn: vi.fn<(message: string) => void>(),
      }),
    ).resolves.toEqual({ status: 'skipped', name: null, email: null });
    expect(confirm).toHaveBeenCalledOnce();
  });

  it('accepts complete author and committer overrides persisted in runtime home', async () => {
    const runGit = vi.fn<(args: string[]) => Promise<string>>(async (args) => {
      if (args[0] === '--version') return 'git version 2.50.0\n';
      throw new Error('missing');
    });
    const confirm = vi.fn<(options: unknown) => Promise<boolean>>();

    await expect(
      configureGitIdentity({
        persistedEnv: {
          GIT_AUTHOR_NAME: 'Automation',
          GIT_AUTHOR_EMAIL: 'automation@example.test',
          GIT_COMMITTER_NAME: 'Automation',
          GIT_COMMITTER_EMAIL: 'automation@example.test',
        },
        runGit,
        confirm,
        success: vi.fn<(message: string) => void>(),
      }),
    ).resolves.toEqual({
      status: 'ready',
      name: 'Automation',
      email: 'automation@example.test',
    });
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe('runtime skill root onboarding', () => {
  it('explains the always-on local root when no external roots are selected', () => {
    expect(formatRuntimeSkillRootsNote('/runtime/skills', []))
      .toMatchInlineSnapshot(`
      "Local root (always scanned): /runtime/skills
      External roots: none
      Example external root: ~/.agents/skills (auto-detected when present)
      Expected layout: <root>/<skill-name>/SKILL.md
      Bundled Neondeck skills load automatically."
    `);
  });

  it('lists configured and selected external roots', () => {
    expect(
      formatRuntimeSkillRootsNote('/runtime/skills', [
        '/Users/alice/.agents/skills',
        '/opt/team-skills',
      ]),
    ).toContain(
      'External roots:\n  /Users/alice/.agents/skills\n  /opt/team-skills',
    );
  });
});

describe('onboarding model defaults', () => {
  it('uses the latest ChatGPT subscription model without changing API defaults', () => {
    expect(defaultProviderModel('openai-codex')).toBe(defaultOpenAiCodexModel);
    expect(defaultProviderModel('openai')).toBe('openai/gpt-5.5');
    expect(defaultProviderModel('openrouter')).toBe('openrouter/gpt-5.5');
    expect(defaultProviderModel('opencode')).toBe('opencode/gpt-5.5');
    expect(defaultProviderModel('google-vertex')).toBe(
      'google-vertex/gemini-2.5-pro',
    );
    expect(providerFromModel('openrouter/anthropic/claude-sonnet-4.6')).toBe(
      'openrouter',
    );
    expect(providerFromModel('opencode/gpt-5.6-terra')).toBe('opencode');
    expect(providerFromModel('google-vertex/gemini-2.5-pro')).toBe(
      'google-vertex',
    );
  });

  it('recommends cheap, fast Explore model profiles', () => {
    expect(exploreModelRecommendation).toBe(
      'Recommended: OpenAI Luna or OpenAI Terra at medium reasoning.',
    );
  });
});

describe('onboarding next steps', () => {
  it('points packaged installs to the production server commands', () => {
    expect(formatOnboardingNextSteps(true, 'cloud')).toEqual([
      '',
      'Next:',
      '  neondeck open  # start the server and open the UI',
      '',
      'Optional login service:',
      '  neondeck service install',
      '',
      'Optional diagnostics:',
      '  neondeck doctor --repo cloud',
    ]);
  });

  it('keeps source checkout development guidance', () => {
    expect(formatOnboardingNextSteps(false)).toEqual([
      '',
      'Next:',
      '  npm run dev',
      '  open http://127.0.0.1:5173/',
    ]);
  });

  it('recognizes an explicit packaged server entry', () => {
    expect(
      hasPackagedServerEntry({
        NEONDECK_SERVER_ENTRY: import.meta.filename,
      }),
    ).toBe(true);
  });
});
