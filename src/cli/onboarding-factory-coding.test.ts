import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { discoverLocalCodexAuth } from '../modules/factory/codex-local-auth';
import { note } from '@clack/prompts';
import * as v from 'valibot';
import { afterEach, expect, it, vi } from 'vitest';
import { factoryCodingConfigSchema } from '../../shared/factory-coding';
import { ensureRuntimeHome, runtimePaths } from '../runtime-home';
import {
  configureFactoryCoding,
  factoryCodingSetupReadiness,
} from './onboarding-factory-coding';
import { configureFactory } from './onboarding-factory';
import { readFactorySetup } from './onboarding-factory-state';
import { promptConfirm, promptSelect, promptText } from './prompts';

vi.mock('./prompts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./prompts')>()),
  promptConfirm: vi.fn<typeof promptConfirm>(),
  promptSelect: vi.fn<typeof promptSelect>(),
  promptText: vi.fn<typeof promptText>(),
}));
vi.mock('@clack/prompts', () => ({
  log: { info: vi.fn<(message: string) => void>() },
  note: vi.fn<typeof note>(),
}));
vi.mock('../modules/factory/codex-local-auth', () => ({
  discoverLocalCodexAuth: vi.fn<typeof discoverLocalCodexAuth>(() => ({
    available: false,
    path: '/synthetic/auth.json',
    reason: 'unavailable',
  })),
}));
const homes: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});
function codingAnswers(executable: string, path: string) {
  vi.mocked(promptSelect).mockImplementation(async ({ message }) => {
    if (message === 'Intake setup') return 'manual';
    if (message === 'Coding CLI') return 'codex';
    if (message.startsWith('Coding model')) return 'gpt-5.6-sol';
    return 'api-key';
  });
  vi.mocked(promptText).mockImplementation(async ({ message }) => {
    if (message === 'Absolute installed executable path') return executable;
    if (message.startsWith('Executable search PATH')) return path;
    return 'FACTORY_CODING_AUTH';
  });
}
it('probes an env-node wrapper, saves and reuses explicit settings without ambient secrets', async () => {
  const home = await mkdtemp(join(tmpdir(), 'onboarding-path-'));
  homes.push(home);
  const paths = runtimePaths(join(home, 'runtime'));
  await ensureRuntimeHome(paths);
  const bin = join(home, 'node-bin');
  await mkdir(bin);
  await symlink(process.execPath, join(bin, 'node'));
  const executable = join(home, 'coding-cli');
  await writeFile(
    executable,
    `#!/usr/bin/env node
if (process.env.ONBOARDING_SECRET || process.env.FACTORY_CODING_AUTH || process.argv[2] !== '--version') process.exit(1);
console.log('codex-cli 0.150.1');
`,
    { mode: 0o755 },
  );
  vi.stubEnv('ONBOARDING_SECRET', 'synthetic-ambient-secret');
  vi.stubEnv('FACTORY_CODING_AUTH', 'synthetic-auth-secret');
  vi.stubEnv('PATH', '/ambient/path-must-not-be-copied');
  const baseline = v.parse(factoryCodingConfigSchema, {
    executable,
    model: 'gpt-5.6-sol',
  });
  expect(
    (await factoryCodingSetupReadiness(baseline)).join('\n'),
  ).not.toContain('supported installed version');
  const path = `${bin}:/usr/bin:/bin`;
  vi.mocked(promptConfirm).mockImplementation(async ({ message }) => {
    if (message.startsWith('Enable')) return false;
    return true;
  });
  codingAnswers(executable, path);
  await configureFactory(paths);
  const preview = vi
    .mocked(note)
    .mock.calls.find((call) => call[1] === 'Review factory setup')?.[0];
  expect(preview).toContain(JSON.stringify(path));
  expect(preview).toContain('supported installed version');
  const saved = readFactorySetup(paths).factory.coding;
  expect(saved.path).toBe(path);
  expect(saved.enabled).toBe(false);
  const bytes = await readFile(paths.config, 'utf8');
  expect(bytes).not.toContain('synthetic-');
  expect(bytes).not.toContain('/ambient/');
  expect((await factoryCodingSetupReadiness(saved)).join('\n')).toContain(
    'supported installed version',
  );
  vi.mocked(promptText).mockClear();
  vi.mocked(promptConfirm).mockImplementation(
    async ({ message }) => !message.startsWith('Edit executable'),
  );
  expect(
    await configureFactoryCoding(saved, {
      home,
      node: process.execPath,
      env: {},
    }),
  ).toEqual(saved);
  expect(promptText).not.toHaveBeenCalled();
});
it('autodetects a CLI and derives wrapper PATH without mandatory path prompts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'onboarding-detect-'));
  homes.push(home);
  const bin = join(home, '.local/bin');
  await mkdir(bin, { recursive: true });
  const executable = join(bin, 'codex');
  await writeFile(executable, '#!/usr/bin/env node\n', { mode: 0o755 });
  const current = v.parse(factoryCodingConfigSchema, { enabled: true });
  codingAnswers(executable, '');
  vi.mocked(promptConfirm).mockImplementation(
    async ({ message }) => !message.startsWith('Edit executable'),
  );
  const next = await configureFactoryCoding(current, {
    home,
    node: process.execPath,
    env: { PATH: ':relative:/usr/bin' },
  });
  expect(next.executable).toBe(executable);
  expect(next.enabled).toBe(true);
  expect(next.path.split(':')).toContain(dirname(process.execPath));
  expect(
    vi.mocked(promptText).mock.calls.map(([options]) => options.message),
  ).toEqual(['Credential environment variable name (never the secret value)']);
});
it('offers a discovered local Codex login as the default reference without storing credentials', async () => {
  const home = await mkdtemp(join(tmpdir(), 'onboarding-login-'));
  homes.push(home);
  const executable = join(home, 'codex');
  await writeFile(executable, '', { mode: 0o755 });
  vi.mocked(discoverLocalCodexAuth).mockReturnValueOnce({
    available: true,
    path: join(home, 'auth.json'),
    reason: null,
  });
  vi.mocked(promptConfirm).mockImplementation(
    async ({ message }) => !message.startsWith('Edit executable'),
  );
  vi.mocked(promptSelect).mockImplementation(async ({ message }) =>
    message === 'Coding CLI'
      ? 'codex'
      : message.startsWith('Coding model')
        ? 'gpt-5.6-sol'
        : 'codex-local',
  );
  const next = await configureFactoryCoding(
    v.parse(factoryCodingConfigSchema, {}),
    { home, node: process.execPath, env: { PATH: home } },
  );
  expect(next.auth).toEqual({
    kind: 'codex-local',
    path: join(home, 'auth.json'),
  });
  const authPrompt = vi
    .mocked(promptSelect)
    .mock.calls.find(([options]) =>
      options.message.startsWith('Isolated credential'),
    )![0];
  expect(authPrompt.initialValue).toBe('codex-local');
  expect(promptText).not.toHaveBeenCalled();
});
it('does not report missing credentials as authenticated', async () => {
  vi.stubEnv('FACTORY_MISSING_TEST_KEY', undefined);
  const config = v.parse(factoryCodingConfigSchema, {
    executable: '/synthetic/missing',
    model: 'gpt-5.6-sol',
    auth: { kind: 'api-key', env: 'FACTORY_MISSING_TEST_KEY' },
  });
  const lines = (await factoryCodingSetupReadiness(config)).join('\n');
  expect(lines).toContain('missing or invalid');
  expect(lines).not.toContain('locally valid');
});
it('defaults away from a missing environment reference toward available local login on rerun', async () => {
  const home = await mkdtemp(join(tmpdir(), 'onboarding-repair-'));
  homes.push(home);
  const executable = join(home, 'codex');
  await writeFile(executable, '', { mode: 0o755 });
  vi.mocked(discoverLocalCodexAuth).mockReturnValueOnce({
    available: true,
    path: join(home, 'auth.json'),
    reason: null,
  });
  const current = v.parse(factoryCodingConfigSchema, {
    executable,
    model: 'gpt-5.6-sol',
    auth: { kind: 'api-key', env: 'FACTORY_CODING_AUTH' },
    path: '/configured/bin:/usr/bin:/bin',
  });
  vi.mocked(promptConfirm).mockImplementation(
    async ({ message, initialValue }) =>
      message === 'Set up an installed coding CLI?'
        ? true
        : Boolean(initialValue),
  );
  vi.mocked(promptSelect).mockImplementation(async ({ message }) =>
    message === 'Coding CLI'
      ? 'codex'
      : message.startsWith('Coding model')
        ? 'gpt-5.6-sol'
        : 'codex-local',
  );
  const next = await configureFactoryCoding(current, {
    home,
    node: process.execPath,
    env: {},
  });
  expect(next.auth).toEqual({
    kind: 'codex-local',
    path: join(home, 'auth.json'),
  });
  expect(next.path).toBe(current.path);
  expect(
    vi
      .mocked(promptConfirm)
      .mock.calls.find(([options]) =>
        options.message.startsWith('Keep the configured'),
      )?.[0].initialValue,
  ).toBe(false);
});
