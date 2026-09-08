vi.mock('./onboarding-factory-workflows', () => ({
  configureFactoryWorkflows: vi.fn().mockResolvedValue(undefined),
}));
import { log, note } from '@clack/prompts';
import { MAX_FACTORY_GITHUB_CONNECTIONS } from '../../shared/factory';
import { writeFileSync } from 'node:fs';
import * as agentConfig from '../modules/runtime/agent-config';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ensureRuntimeHome, runtimePaths } from '../runtime-home';
import { updateFactoryConfig } from '../modules/config';
import {
  applyFactorySetup,
  readFactorySetup,
} from './onboarding-factory-state';
import { configureFactory } from './onboarding-factory';
import {
  promptConfirm,
  promptSelect,
  promptText,
  promptMultiselect,
} from './prompts';
import { readFactoryGitHubRepository } from '../modules/github';
import { writeFile } from 'node:fs/promises';
vi.mock('./prompts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./prompts')>()),
  promptConfirm: vi.fn<typeof promptConfirm>(),
  promptSelect: vi.fn<typeof promptSelect>(),
  promptText: vi.fn<typeof promptText>(),
  promptMultiselect: vi.fn<typeof promptMultiselect>(),
}));
vi.mock('../modules/github', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../modules/github')>()),
  readFactoryGitHubRepository: vi.fn<typeof readFactoryGitHubRepository>(),
}));
vi.mock('@clack/prompts', () => ({
  log: { info: vi.fn<(message: string) => void>() },
  note: vi.fn<(message: string) => void>(),
}));
const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'factory-onboarding-test-'));
  homes.push(home);
  const paths = runtimePaths(home);
  await ensureRuntimeHome(paths);
  return paths;
}
it('skips without even reading or preparing a missing runtime home', async () => {
  vi.mocked(promptConfirm).mockResolvedValue(false);
  await expect(
    configureFactory(runtimePaths('/nonexistent/factory-onboarding')),
  ).resolves.toBeUndefined();
});
it('retains unrelated configuration and existing coding authority when resumed', async () => {
  const paths = await fixture();
  updateFactoryConfig({ enabled: true, coding: { enabled: true } }, paths);
  const before = readFactorySetup(paths);
  applyFactorySetup(paths, before.fingerprint, {
    ...before.factory,
    github: [],
  });
  expect(readFactorySetup(paths).config).toEqual(before.config);
  expect(readFactorySetup(paths).factory.coding.enabled).toBe(true);
});
it.each([false, true])(
  'repairs coding config with removed model providers while preserving coding authority %s',
  async (codingEnabled) => {
    const paths = await fixture();
    updateFactoryConfig(
      { enabled: true, coding: { enabled: codingEnabled } },
      paths,
    );
    const config = readFactorySetup(paths).config;
    await writeFile(
      paths.config,
      JSON.stringify({
        ...config,
        models: {
          ...config.models,
          displayAssistant: 'removed-provider/planning',
          utility: 'removed-provider/utility',
        },
      }),
    );
    const before = readFactorySetup(paths);
    expect(before.modelIssues).toEqual([
      'removed-provider/planning',
      'removed-provider/utility',
    ]);
    const proposal = {
      ...before.factory,
      coding: { ...before.factory.coding, model: 'repaired-coding-model' },
    };

    expect(applyFactorySetup(paths, before.fingerprint, proposal)).toEqual(
      proposal,
    );
    const after = readFactorySetup(paths);
    expect(after.config).toEqual({ ...before.config, factory: proposal });
    expect(after.factory.coding.enabled).toBe(codingEnabled);
    expect(after.modelIssues).toEqual(before.modelIssues);
  },
);
it.each(['displayAssistant', 'utility'] as const)(
  'rejects enabling intake with an invalid %s model without writing config',
  async (role) => {
    const paths = await fixture();
    const config = readFactorySetup(paths).config;
    await writeFile(
      paths.config,
      JSON.stringify({
        ...config,
        models: {
          ...config.models,
          displayAssistant: 'kilocode/planning',
          utility: 'kilocode/utility',
          [role]: 'removed-provider/model',
        },
      }),
    );
    const before = readFactorySetup(paths);
    expect(before.factory.enabled).toBe(false);
    expect(before.modelIssues).toEqual(['removed-provider/model']);
    const bytes = await readFile(paths.config, 'utf8');

    expect(() =>
      applyFactorySetup(paths, before.fingerprint, {
        ...before.factory,
        enabled: true,
      }),
    ).toThrow('Configure registered planning and utility model references');
    expect(await readFile(paths.config, 'utf8')).toBe(bytes);
  },
);
it('rejects stale previews without changing the newer configuration', async () => {
  const paths = await fixture();
  const before = readFactorySetup(paths);
  updateFactoryConfig({ enabled: true }, paths);
  const bytes = await readFile(paths.config, 'utf8');
  expect(() =>
    applyFactorySetup(paths, before.fingerprint, before.factory),
  ).toThrow('changed during setup');
  expect(await readFile(paths.config, 'utf8')).toBe(bytes);
});
it('cannot enable coding or disable an existing factory', async () => {
  const paths = await fixture();
  let before = readFactorySetup(paths);
  expect(() =>
    applyFactorySetup(paths, before.fingerprint, {
      ...before.factory,
      coding: { enabled: true },
    }),
  ).toThrow('coding authority');
  updateFactoryConfig({ enabled: true }, paths);
  before = readFactorySetup(paths);
  expect(() =>
    applyFactorySetup(paths, before.fingerprint, {
      ...before.factory,
      enabled: false,
    }),
  ).toThrow('disable');
});
it('rejects secret values in reference fields through the shared schema', async () => {
  const paths = await fixture();
  const before = readFactorySetup(paths);
  expect(() =>
    applyFactorySetup(paths, before.fingerprint, {
      ...before.factory,
      coding: { auth: { kind: 'api-key', env: 'not a variable name' } },
    }),
  ).toThrow(/Invalid/);
});

it('declines the review without writing factory configuration', async () => {
  const paths = await fixture();
  const bytes = await readFile(paths.config, 'utf8');
  vi.mocked(promptConfirm).mockResolvedValueOnce(true).mockResolvedValue(false);
  vi.mocked(promptSelect).mockResolvedValue('manual');
  await configureFactory(paths);
  expect(await readFile(paths.config, 'utf8')).toBe(bytes);
});
it.each([false, true])(
  'saves a disabled GitHub connection with invalid models and factory enabled %s',
  async (enabled) => {
    const paths = await fixture();
    updateFactoryConfig({ enabled }, paths);
    const config = readFactorySetup(paths).config;
    await writeFile(
      paths.config,
      JSON.stringify({
        ...config,
        models: {
          ...config.models,
          displayAssistant: 'removed-provider/planning',
          utility: 'removed-provider/utility',
        },
      }),
    );
    const before = readFactorySetup(paths);
    expect(before.modelIssues).toHaveLength(2);
    await writeFile(
      paths.repos,
      JSON.stringify({
        repos: [
          {
            id: 'fixture',
            path: '/tmp/fixture',
            defaultBranch: 'main',
            github: { owner: 'example', name: 'fixture' },
          },
        ],
      }),
    );
    vi.stubEnv('SETUP_TEST_TOKEN', 'synthetic-fixture');
    vi.mocked(readFactoryGitHubRepository).mockResolvedValue({
      id: 42,
      name: 'fixture',
      owner: { login: 'example' },
    });
    vi.mocked(promptConfirm).mockResolvedValueOnce(true);
    if (!enabled) vi.mocked(promptConfirm).mockResolvedValueOnce(false);
    vi.mocked(promptConfirm)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    vi.mocked(promptSelect)
      .mockResolvedValueOnce('github')
      .mockResolvedValueOnce('all');
    vi.mocked(promptMultiselect).mockResolvedValue(['fixture']);
    vi.mocked(promptText)
      .mockResolvedValueOnce('fixture-intake')
      .mockResolvedValueOnce('SETUP_TEST_SECRET')
      .mockResolvedValueOnce('SETUP_TEST_TOKEN');
    await configureFactory(paths);
    expect(readFactoryGitHubRepository).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenEnv: 'SETUP_TEST_TOKEN',
        owner: 'example',
        name: 'fixture',
      }),
    );
    expect(readFactorySetup(paths).factory.enabled).toBe(enabled);
    expect(readFactorySetup(paths).modelIssues).toEqual(before.modelIssues);
    expect(readFactorySetup(paths).factory.github).toEqual([
      expect.objectContaining({ repositoryId: '42', enabled: false }),
    ]);
    expect(await readFile(paths.config, 'utf8')).not.toContain(
      'synthetic-fixture',
    );
  },
);
it('checks the preview fingerprint inside the shared factory mutation service', async () => {
  const paths = await fixture();
  const before = readFactorySetup(paths);
  updateFactoryConfig({ enabled: true }, paths);
  const bytes = await readFile(paths.config, 'utf8');
  expect(() =>
    updateFactoryConfig(before.factory, paths, {
      expectedFingerprint: before.fingerprint,
    }),
  ).toThrow('changed during setup');
  expect(await readFile(paths.config, 'utf8')).toBe(bytes);
});
it('rejects the second coding client after the first saves the same snapshot', async () => {
  const { saveFactoryCodingConfig, factoryCodingState } =
    await import('../modules/factory/coding-operator');
  const paths = await fixture();
  const first = await factoryCodingState(paths);
  const second = { ...first };
  await saveFactoryCodingConfig(
    {
      expectedFingerprint: first.configFingerprint,
      config: { ...first.config, model: 'first-client' },
    },
    paths,
  );
  await expect(
    saveFactoryCodingConfig(
      {
        expectedFingerprint: second.configFingerprint,
        config: { ...second.config, model: 'stale-second-client' },
      },
      paths,
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(readFactorySetup(paths).factory.coding.model).toBe('first-client');
});
it('runs section preconditions after acquiring the shared lock against current config', async () => {
  const paths = await fixture();
  const first = readFactorySetup(paths);
  updateFactoryConfig({ enabled: true }, paths);
  let inspected = false;
  expect(() =>
    updateFactoryConfig(first.factory, paths, {
      precondition(before) {
        inspected = true;
        expect(before.factory?.enabled).toBe(true);
        throw new Error('stale section rejected');
      },
    }),
  ).toThrow('stale section rejected');
  expect(inspected).toBe(true);
  expect(readFactorySetup(paths).factory.enabled).toBe(true);
});

it('rejects a registry change between the preview read and fingerprint calculation', async () => {
  const paths = await fixture();
  const before = readFactorySetup(paths);
  const bytes = await readFile(paths.config, 'utf8');
  const changedRegistry = JSON.stringify({
    repos: [
      {
        id: 'added',
        path: '/tmp/added',
        defaultBranch: 'main',
        github: { owner: 'example', name: 'added' },
      },
    ],
  });
  const resolveModels = agentConfig.resolveAgentModelSelection;
  // Model resolution runs after the preview reads repos but before it hashes them.
  const modelSpy = vi
    .spyOn(agentConfig, 'resolveAgentModelSelection')
    .mockImplementationOnce((config) => {
      writeFileSync(paths.repos, changedRegistry);
      return resolveModels(config);
    });
  const preview = readFactorySetup(paths);
  modelSpy.mockRestore();

  expect(preview.repos).toEqual(before.repos);
  expect(preview.fingerprint).toBe(before.fingerprint);
  expect(readFactorySetup(paths).fingerprint).not.toBe(preview.fingerprint);
  const proposal = { ...preview.factory, enabled: true };
  expect(() => applyFactorySetup(paths, preview.fingerprint, proposal)).toThrow(
    'changed during setup',
  );
  // The mutation service independently rejects that same stale preview under its lock.
  expect(() =>
    updateFactoryConfig(proposal, paths, {
      expectedFingerprint: preview.fingerprint,
    }),
  ).toThrow('changed during setup');
  expect(await readFile(paths.config, 'utf8')).toBe(bytes);
  expect(await readFile(paths.repos, 'utf8')).toBe(changedRegistry);
});

it.each(['github', 'unsupported'])(
  'continues without mutation for unavailable intake selection %j with no repositories',
  async (selection) => {
    const paths = await fixture();
    const bytes = await readFile(paths.config, 'utf8');
    const repos = await readFile(paths.repos, 'utf8');
    vi.mocked(promptConfirm).mockResolvedValue(true);
    vi.mocked(promptSelect).mockResolvedValue(selection);

    await expect(configureFactory(paths)).resolves.toBeUndefined();

    expect(promptSelect).toHaveBeenCalledExactlyOnceWith({
      message: 'Intake setup',
      options: [expect.objectContaining({ value: 'manual' })],
    });
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('neondeck repo add'),
    );
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('neondeck factory setup'),
    );
    expect(promptText).not.toHaveBeenCalled();
    expect(readFactoryGitHubRepository).not.toHaveBeenCalled();
    expect(await readFile(paths.config, 'utf8')).toBe(bytes);
    expect(await readFile(paths.repos, 'utf8')).toBe(repos);
    expect(promptConfirm).not.toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Apply this local factory configuration?',
      }),
    );
  },
);

it('keeps manual intake available without a repository', async () => {
  const paths = await fixture();
  vi.mocked(promptConfirm)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true);
  vi.mocked(promptSelect).mockResolvedValue('manual');

  await configureFactory(paths);

  expect(readFactorySetup(paths).factory.enabled).toBe(true);
  expect(readFactorySetup(paths).factory.github).toEqual([]);
  expect(readFactoryGitHubRepository).not.toHaveBeenCalled();
});

it.each(['removed-repo', ''])(
  'continues without mutation for stale or unsupported repository selection %j',
  async (selection) => {
    const paths = await fixture();
    await writeFile(
      paths.repos,
      JSON.stringify({
        repos: [
          {
            id: 'fixture',
            path: '/tmp/fixture',
            defaultBranch: 'main',
            github: { owner: 'example', name: 'fixture' },
          },
        ],
      }),
    );
    const bytes = await readFile(paths.config, 'utf8');
    vi.mocked(promptConfirm).mockResolvedValue(true);
    vi.mocked(promptSelect).mockResolvedValueOnce('github');
    vi.mocked(promptMultiselect).mockResolvedValue([selection]);

    await expect(configureFactory(paths)).resolves.toBeUndefined();

    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('Repository selection is unavailable'),
    );
    expect(promptText).not.toHaveBeenCalled();
    expect(readFactoryGitHubRepository).not.toHaveBeenCalled();
    expect(await readFile(paths.config, 'utf8')).toBe(bytes);
  },
);

it('propagates invalid configuration from the optional wizard', async () => {
  const paths = await fixture();
  await writeFile(paths.config, '{invalid');
  vi.mocked(promptConfirm).mockResolvedValue(true);
  await expect(configureFactory(paths)).rejects.toThrow(paths.config);
  expect(await readFile(paths.config, 'utf8')).toBe('{invalid');
  expect(promptSelect).not.toHaveBeenCalled();
});

it('propagates apply precondition failures from the optional wizard', async () => {
  const paths = await fixture();
  const config = readFactorySetup(paths).config;
  await writeFile(
    paths.config,
    JSON.stringify({
      ...config,
      models: { ...config.models, utility: 'removed-provider/model' },
    }),
  );
  const bytes = await readFile(paths.config, 'utf8');
  vi.mocked(promptConfirm)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true);
  vi.mocked(promptSelect).mockResolvedValue('manual');

  await expect(configureFactory(paths)).rejects.toThrow(
    'Configure registered planning and utility model references',
  );
  expect(await readFile(paths.config, 'utf8')).toBe(bytes);
});

it('allows only an explicitly authorized false-to-true coding transition', async () => {
  const paths = await fixture();
  const before = readFactorySetup(paths);
  const proposal = {
    ...before.factory,
    coding: { ...before.factory.coding, enabled: true },
  };
  expect(() => applyFactorySetup(paths, before.fingerprint, proposal)).toThrow(
    'coding authority',
  );
  applyFactorySetup(paths, before.fingerprint, proposal, {
    enableCoding: true,
  });
  const enabled = readFactorySetup(paths);
  expect(enabled.factory.coding.enabled).toBe(true);
  expect(() =>
    applyFactorySetup(paths, enabled.fingerprint, before.factory, {
      enableCoding: true,
    }),
  ).toThrow('coding authority');
});

async function registerSetupRepos(paths: ReturnType<typeof runtimePaths>) {
  await writeFile(
    paths.repos,
    JSON.stringify({
      repos: ['one', 'two'].map((id) => ({
        id,
        path: `/tmp/${id}`,
        defaultBranch: 'main',
        github: { owner: 'example', name: id },
      })),
    }),
  );
}

function manualChoices(enable: boolean, apply: boolean) {
  vi.mocked(promptSelect).mockResolvedValue('manual');
  vi.mocked(promptConfirm).mockImplementation(async ({ message }) => {
    if (message === 'Enable coding for human-released tasks?') return enable;
    if (message === 'Apply this local factory configuration?') return apply;
    return message === 'Set up optional factory intake now?';
  });
}

it.each([false, true])(
  'requires final Apply after coding opt-in: %s',
  async (apply) => {
    const paths = await fixture();
    await registerSetupRepos(paths);
    const bytes = await readFile(paths.config, 'utf8');
    manualChoices(true, apply);
    await configureFactory(paths);
    expect(readFactorySetup(paths).factory.coding.enabled).toBe(apply);
    expect((await readFile(paths.config, 'utf8')) === bytes).toBe(!apply);
    expect(promptMultiselect).not.toHaveBeenCalled();
    expect(promptSelect).toHaveBeenCalledTimes(1);
    expect(promptConfirm).toHaveBeenCalledWith({
      message: 'Enable coding for human-released tasks?',
      initialValue: false,
    });
  },
);

it('retains enabled coding without asking an enable question', async () => {
  const paths = await fixture();
  updateFactoryConfig({ coding: { enabled: true } }, paths);
  manualChoices(false, true);
  await configureFactory(paths);
  expect(readFactorySetup(paths).factory.coding.enabled).toBe(true);
  expect(promptConfirm).not.toHaveBeenCalledWith(
    expect.objectContaining({
      message: 'Enable coding for human-released tasks?',
    }),
  );
  expect(log.info).toHaveBeenCalledWith(
    expect.stringContaining('Coding remains enabled'),
  );
});

it('adds multiple disabled connections once and preserves existing connections on repeat setup', async () => {
  const paths = await fixture();
  await registerSetupRepos(paths);
  manualChoices(false, true);
  vi.mocked(promptSelect).mockImplementation(async ({ message }) =>
    message === 'Intake setup' ? 'github' : 'all',
  );
  vi.mocked(promptMultiselect).mockResolvedValue(['one', 'two', 'one']);
  vi.stubEnv('SETUP_TEST_TOKEN', 'synthetic-fixture');
  vi.mocked(readFactoryGitHubRepository).mockImplementation(
    async (connection) => ({
      id: connection.repoId === 'one' ? 1 : 2,
      name: connection.name,
      owner: { login: connection.owner },
    }),
  );
  vi.mocked(promptText)
    .mockResolvedValueOnce('one-intake')
    .mockResolvedValueOnce('ONE_SECRET')
    .mockResolvedValueOnce('SETUP_TEST_TOKEN')
    .mockResolvedValueOnce('two-intake')
    .mockResolvedValueOnce('TWO_SECRET')
    .mockResolvedValueOnce('SETUP_TEST_TOKEN');
  await configureFactory(paths);
  const first = readFactorySetup(paths).factory;
  expect(first.github).toEqual([
    expect.objectContaining({
      id: 'one-intake',
      repoId: 'one',
      repositoryId: '1',
      enabled: false,
      webhookSecretEnv: 'ONE_SECRET',
    }),
    expect.objectContaining({
      id: 'two-intake',
      repoId: 'two',
      repositoryId: '2',
      enabled: false,
      webhookSecretEnv: 'TWO_SECRET',
    }),
  ]);
  await configureFactory(paths);
  expect(readFactorySetup(paths).factory).toEqual(first);
  expect(readFactoryGitHubRepository).toHaveBeenCalledTimes(2);
  expect(promptText).toHaveBeenCalledTimes(6);
  const preview = vi
    .mocked(note)
    .mock.calls.map(([message]) => message)
    .join('\n');
  expect(preview).toContain('references only');
  expect(preview).toContain('ONE_SECRET');
  expect(preview).not.toContain('synthetic-fixture');
});

it('handles empty selection without adding connections', async () => {
  const paths = await fixture();
  await registerSetupRepos(paths);
  manualChoices(false, true);
  vi.mocked(promptSelect).mockResolvedValue('github');
  vi.mocked(promptMultiselect).mockResolvedValue([]);
  await configureFactory(paths);
  expect(readFactorySetup(paths).factory.github).toEqual([]);
  expect(readFactoryGitHubRepository).not.toHaveBeenCalled();
});

it.each(['failure', 'cancel'])(
  'does not save the first connection when the second encounters %s',
  async (mode) => {
    const paths = await fixture();
    await registerSetupRepos(paths);
    const bytes = await readFile(paths.config, 'utf8');
    manualChoices(false, true);
    vi.mocked(promptSelect).mockImplementation(async ({ message }) =>
      message === 'Intake setup' ? 'github' : 'all',
    );
    vi.mocked(promptMultiselect).mockResolvedValue(['one', 'two']);
    vi.stubEnv('SETUP_TEST_TOKEN', 'synthetic-fixture');
    vi.mocked(readFactoryGitHubRepository)
      .mockResolvedValueOnce({
        id: 1,
        name: 'one',
        owner: { login: 'example' },
      })
      .mockRejectedValueOnce(new Error('lookup failed'));
    vi.mocked(promptText)
      .mockResolvedValueOnce('one')
      .mockResolvedValueOnce('ONE_SECRET')
      .mockResolvedValueOnce('SETUP_TEST_TOKEN');
    if (mode === 'cancel')
      vi.mocked(promptText).mockRejectedValueOnce(new Error('cancelled'));
    else
      vi.mocked(promptText)
        .mockResolvedValueOnce('two')
        .mockResolvedValueOnce('TWO_SECRET')
        .mockResolvedValueOnce('SETUP_TEST_TOKEN');
    const result = await configureFactory(paths).then(
      () => 'completed',
      (error: Error) => error.message,
    );
    expect(result).toBe(mode === 'cancel' ? 'cancelled' : 'completed');
    expect(await readFile(paths.config, 'utf8')).toBe(bytes);
  },
);

it('explains existing released work and factory-off blocking before coding opt-in', async () => {
  const paths = await fixture();
  manualChoices(true, true);
  await configureFactory(paths);
  const codingPrompt = vi
    .mocked(promptConfirm)
    .mock.calls.findIndex(
      ([options]) =>
        options.message === 'Enable coding for human-released tasks?',
    );
  for (const text of [
    'existing human-released tasks',
    'will not dispatch until factory intake is enabled',
  ]) {
    const info = vi
      .mocked(log.info)
      .mock.calls.findIndex(([message]) => message.includes(text));
    expect(info).toBeGreaterThanOrEqual(0);
    expect(vi.mocked(log.info).mock.invocationCallOrder[info]).toBeLessThan(
      vi.mocked(promptConfirm).mock.invocationCallOrder[codingPrompt]!,
    );
  }
  expect(readFactorySetup(paths).factory.enabled).toBe(false);
  expect(readFactorySetup(paths).factory.coding.enabled).toBe(true);
});

it('rejects explicit coding opt-in when the repository snapshot changed', async () => {
  const paths = await fixture();
  const before = readFactorySetup(paths);
  const bytes = await readFile(paths.config, 'utf8');
  await registerSetupRepos(paths);
  expect(() =>
    applyFactorySetup(
      paths,
      before.fingerprint,
      {
        ...before.factory,
        coding: { ...before.factory.coding, enabled: true },
      },
      { enableCoding: true },
    ),
  ).toThrow('changed during setup');
  expect(await readFile(paths.config, 'utf8')).toBe(bytes);
});

async function capacityFixture(existingCount: number) {
  const paths = await fixture();
  await writeFile(
    paths.repos,
    JSON.stringify({
      repos: ['existing-0', 'one', 'two', 'three'].map((id) => ({
        id,
        path: `/tmp/${id}`,
        defaultBranch: 'main',
        github: { owner: 'example', name: id },
      })),
    }),
  );
  updateFactoryConfig(
    {
      github: Array.from({ length: existingCount }, (_, index) => ({
        id: `connection-${index}`,
        repoId: `existing-${index}`,
        enabled: index === 0,
        repositoryId: String(index + 1),
        owner: 'example',
        name: `existing-${index}`,
        admission: { mode: 'all' as const },
        webhookSecretEnv: 'EXISTING_SECRET',
        tokenEnv: 'SETUP_TEST_TOKEN',
      })),
    },
    paths,
  );
  manualChoices(false, true);
  vi.mocked(promptSelect).mockImplementation(async ({ message }) =>
    message === 'Intake setup' ? 'github' : 'all',
  );
  return paths;
}

it.each([0, 1, 2])(
  'rejects additions beyond %s remaining slots before details or metadata',
  async (remaining) => {
    const paths = await capacityFixture(
      MAX_FACTORY_GITHUB_CONNECTIONS - remaining,
    );
    const bytes = await readFile(paths.config, 'utf8');
    vi.mocked(promptMultiselect).mockResolvedValue(['one', 'two', 'three']);
    await expect(configureFactory(paths)).resolves.toBeUndefined();
    expect(await readFile(paths.config, 'utf8')).toBe(bytes);
    expect(promptText).not.toHaveBeenCalled();
    expect(readFactoryGitHubRepository).not.toHaveBeenCalled();
    expect(promptConfirm).not.toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Apply this local factory configuration?',
      }),
    );
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining(
        remaining === 0 ? 'slots are in use' : `only ${remaining} slots remain`,
      ),
    );
    expect(promptMultiselect).toHaveBeenCalledTimes(remaining === 0 ? 0 : 1);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining(
        remaining === 0
          ? 'choose manual intake'
          : `select at most ${remaining}`,
      ),
    );
  },
);

it.each([false, true])(
  'stages exactly the remaining capacity atomically, Apply: %s',
  async (apply) => {
    const paths = await capacityFixture(MAX_FACTORY_GITHUB_CONNECTIONS - 2);
    const before = readFactorySetup(paths).factory;
    const bytes = await readFile(paths.config, 'utf8');
    vi.mocked(promptConfirm).mockImplementation(
      async ({ message }) =>
        message === 'Set up optional factory intake now?' ||
        (message === 'Apply this local factory configuration?' && apply),
    );
    vi.mocked(promptMultiselect).mockResolvedValue([
      'existing-0',
      'one',
      'two',
      'one',
    ]);
    vi.stubEnv('SETUP_TEST_TOKEN', 'synthetic-fixture');
    vi.mocked(readFactoryGitHubRepository).mockImplementation(
      async (connection) => ({
        id: connection.repoId === 'one' ? 101 : 102,
        name: connection.name,
        owner: { login: connection.owner },
      }),
    );
    vi.mocked(promptText)
      .mockResolvedValueOnce('one-intake')
      .mockResolvedValueOnce('ONE_SECRET')
      .mockResolvedValueOnce('SETUP_TEST_TOKEN')
      .mockResolvedValueOnce('two-intake')
      .mockResolvedValueOnce('TWO_SECRET')
      .mockResolvedValueOnce('SETUP_TEST_TOKEN');
    await configureFactory(paths);
    expect(promptMultiselect).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          'Repositories for GitHub issue intake (up to 2 new connections)',
      }),
    );
    expect(readFactoryGitHubRepository).toHaveBeenCalledTimes(2);
    const after = readFactorySetup(paths).factory;
    expect(after.github.slice(0, before.github.length)).toEqual(before.github);
    expect(after.github).toHaveLength(before.github.length + (apply ? 2 : 0));
    expect(
      after.github
        .slice(before.github.length)
        .map(({ repoId, enabled }) => ({ repoId, enabled })),
    ).toEqual(
      apply
        ? [
            { repoId: 'one', enabled: false },
            { repoId: 'two', enabled: false },
          ]
        : [],
    );
    expect((await readFile(paths.config, 'utf8')) === bytes).toBe(!apply);
  },
);

it('allows manual setup with all GitHub slots occupied', async () => {
  const paths = await capacityFixture(MAX_FACTORY_GITHUB_CONNECTIONS);
  const before = readFactorySetup(paths).factory.github;
  manualChoices(false, true);
  await configureFactory(paths);
  expect(readFactorySetup(paths).factory.github).toEqual(before);
  expect(promptMultiselect).not.toHaveBeenCalled();
  expect(promptConfirm).toHaveBeenCalledWith(
    expect.objectContaining({
      message: 'Apply this local factory configuration?',
    }),
  );
});
