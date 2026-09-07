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
import { promptConfirm, promptSelect, promptText } from './prompts';
import { readFactoryGitHubRepository } from '../modules/github';
import { writeFile } from 'node:fs/promises';
vi.mock('./prompts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./prompts')>()),
  promptConfirm: vi.fn<typeof promptConfirm>(),
  promptSelect: vi.fn<typeof promptSelect>(),
  promptText: vi.fn<typeof promptText>(),
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
it('looks up GitHub identity using the selected reference and saves a disabled connection', async () => {
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
  vi.stubEnv('SETUP_TEST_TOKEN', 'synthetic-fixture');
  vi.mocked(readFactoryGitHubRepository).mockResolvedValue({
    id: 42,
    name: 'fixture',
    owner: { login: 'example' },
  });
  vi.mocked(promptConfirm)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true);
  vi.mocked(promptSelect)
    .mockResolvedValueOnce('github')
    .mockResolvedValueOnce('fixture')
    .mockResolvedValueOnce('all');
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
  expect(readFactorySetup(paths).factory.github).toEqual([
    expect.objectContaining({ repositoryId: '42', enabled: false }),
  ]);
  expect(await readFile(paths.config, 'utf8')).not.toContain(
    'synthetic-fixture',
  );
});
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
