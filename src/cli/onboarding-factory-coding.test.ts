import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const homes: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});
function codingAnswers(executable: string, path: string) {
  vi.mocked(promptSelect)
    .mockResolvedValueOnce('codex')
    .mockResolvedValueOnce('api-key');
  vi.mocked(promptText)
    .mockResolvedValueOnce(executable)
    .mockResolvedValueOnce(path)
    .mockResolvedValueOnce('gpt-5.4')
    .mockResolvedValueOnce('FACTORY_CODING_AUTH');
}
it('probes an env-node npm wrapper with the reviewed PATH, saves and reuses it without ambient secrets', async () => {
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
  const initial = readFactorySetup(paths);
  const baseline = v.parse(factoryCodingConfigSchema, {
    executable,
    model: 'gpt-5.4',
  });
  expect(
    (await factoryCodingSetupReadiness(baseline)).join('\n'),
  ).not.toContain('supported installed version');
  const path = `${bin}:/usr/bin:/bin`;
  vi.mocked(promptConfirm)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true)
    .mockImplementationOnce(async () => {
      const preview = vi
        .mocked(note)
        .mock.calls.find((call) => call[1] === 'Review factory setup')?.[0];
      expect(preview).toContain(JSON.stringify(path));
      expect(preview).toContain('supported installed version');
      expect(readFactorySetup(paths).factory).toEqual(initial.factory);
      return true;
    });
  vi.mocked(promptSelect).mockResolvedValueOnce('manual');
  codingAnswers(executable, path);
  await configureFactory(paths);
  const saved = readFactorySetup(paths).factory.coding;
  expect(saved.path).toBe(path);
  expect(saved.enabled).toBe(initial.factory.coding.enabled);
  const bytes = await readFile(paths.config, 'utf8');
  expect(bytes).not.toContain('synthetic-');
  expect(bytes).not.toContain('/ambient/');
  expect((await factoryCodingSetupReadiness(saved)).join('\n')).toContain(
    'supported installed version',
  );
  vi.mocked(promptConfirm).mockResolvedValueOnce(true);
  codingAnswers(executable, path);
  expect(await configureFactoryCoding(saved)).toEqual(saved);
  const pathPrompts = vi
    .mocked(promptText)
    .mock.calls.filter(([options]) =>
      options.message.startsWith('Executable search PATH'),
    );
  expect(pathPrompts.map(([options]) => options.initialValue)).toEqual([
    '/usr/bin:/bin',
    path,
  ]);
});
it('uses shared PATH validation and preserves existing coding authority', async () => {
  const current = v.parse(factoryCodingConfigSchema, {
    enabled: true,
    path: '/configured/bin:/usr/bin:/bin',
  });
  vi.mocked(promptConfirm).mockResolvedValue(true);
  codingAnswers('/opt/cli', current.path);
  const next = await configureFactoryCoding(current);
  expect(next.enabled).toBe(true);
  const options = vi
    .mocked(promptText)
    .mock.calls.find(([options]) =>
      options.message.startsWith('Executable search PATH'),
    )![0];
  expect(options.initialValue).toBe(current.path);
  const validate = options.validate;
  if (typeof validate !== 'function')
    throw new Error('Expected PATH validator');
  for (const value of [
    '',
    'relative/bin',
    '/bin:',
    ':/bin',
    '/bin::/usr/bin',
    '~/bin:/bin',
  ]) {
    expect(validate(value)).toBeTruthy();
  }
  expect(validate('/opt/node/bin:/usr/bin:/bin')).toBeUndefined();
  codingAnswers('/opt/cli', '/bin:relative');
  await expect(configureFactoryCoding(current)).rejects.toThrow(/Invalid/);
});
