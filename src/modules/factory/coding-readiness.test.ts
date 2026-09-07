import * as codingRuns from '../coding-runs';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ensureRuntimeHome, runtimePaths } from '../../runtime-home';
import { factoryCodingConfigSchema } from '../../../shared/factory-coding';
import * as v from 'valibot';
import { codingReadiness } from './coding-readiness';

const probe = vi.hoisted(() =>
  vi.fn<
    () => Promise<{
      ready: boolean;
      version: string | null;
      reason: string | null;
    }>
  >(),
);
vi.mock('../coding-runs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../coding-runs')>()),
  inspectCodingAdapterReadiness: probe,
  localHostCapability: () => ({ supported: true }),
}));
let root: string;
let paths: ReturnType<typeof runtimePaths>;
let config: v.InferOutput<typeof factoryCodingConfigSchema>;
const unsupported = {
  ready: false,
  version: 'codex-cli unsupported',
  reason: 'unsupported-cli-version',
};
const supported = { ready: true, version: 'codex-cli 0.150.1', reason: null };
function save(factoryEnabled = true) {
  writeFileSync(
    paths.config,
    JSON.stringify({
      version: 1,
      factory: { enabled: factoryEnabled, coding: config },
    }),
  );
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'factory-readiness-'));
  paths = runtimePaths(root);
  await ensureRuntimeHome(paths);
  const executable = join(root, 'synthetic-codex');
  writeFileSync(executable, 'synthetic executable metadata fixture', {
    mode: 0o700,
  });
  config = v.parse(factoryCodingConfigSchema, {
    enabled: true,
    executable,
    model: 'fixture-model',
    auth: { kind: 'api-key', env: 'FACTORY_READINESS_TEST_AUTH' },
  });
  save();
  vi.stubEnv('FACTORY_READINESS_TEST_AUTH', 'synthetic-only');
  probe.mockReset().mockResolvedValue(unsupported);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
it('shares one failed probe across concurrent and repeated loop/UI reads, with isolated response objects', async () => {
  const results = await Promise.all(
    Array.from({ length: 12 }, () => codingReadiness(paths)),
  );
  expect(probe).toHaveBeenCalledTimes(1);
  expect(results.every((r) => !r.ready)).toBe(true);
  results[0].blockers.push('mutated caller');
  for (let n = 0; n < 8; n++)
    expect((await codingReadiness(paths)).blockers).toEqual([
      'unsupported-cli-version',
    ]);
  expect(probe).toHaveBeenCalledTimes(1);
  expect(readdirSync(join(root, 'coding-readiness'))).toEqual([]);
});
it.each(['', ' \t\n'])(
  'caches blank version output %j across concurrent polls and retries changed inputs',
  async (version) => {
    probe.mockResolvedValue({
      ready: false,
      version,
      reason: 'unsupported-cli-version',
    });
    const expected = {
      ready: false,
      installedVersion: null,
      blockers: ['unsupported-cli-version'],
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => codingReadiness(paths)),
    );
    for (const result of results) expect(result).toMatchObject(expected);
    for (let n = 0; n < 4; n++)
      expect(await codingReadiness(paths)).toMatchObject(expected);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(readdirSync(join(root, 'coding-readiness'))).toEqual([]);
    config.model = 'changed-model';
    save();
    expect(await codingReadiness(paths)).toMatchObject(expected);
    expect(probe).toHaveBeenCalledTimes(2);
    writeFileSync(config.executable!, 'fixed supported executable');
    probe.mockResolvedValue(supported);
    expect(await codingReadiness(paths)).toMatchObject({
      ready: true,
      installedVersion: supported.version,
    });
    expect(probe).toHaveBeenCalledTimes(3);
  },
);
it('retries changed configuration and binary metadata including permission repair and replacement', async () => {
  await codingReadiness(paths);
  config.model = 'another-model';
  save();
  await codingReadiness(paths);
  writeFileSync(config.executable!, 'replaced binary with different length');
  await codingReadiness(paths);
  chmodSync(config.executable!, 0o600);
  await codingReadiness(paths);
  rmSync(config.executable!);
  await codingReadiness(paths);
  writeFileSync(config.executable!, 'restored binary', { mode: 0o700 });
  await codingReadiness(paths);
  expect(probe).toHaveBeenCalledTimes(6);
});
it('missing or malformed auth performs no probe and recovers under the same environment reference', async () => {
  vi.stubEnv('FACTORY_READINESS_TEST_AUTH', '');
  for (let n = 0; n < 4; n++)
    expect((await codingReadiness(paths)).ready).toBe(false);
  expect(probe).not.toHaveBeenCalled();
  expect(existsSync(join(root, 'coding-readiness'))).toBe(false);
  vi.stubEnv('FACTORY_READINESS_TEST_AUTH', 'synthetic-populated-later');
  await codingReadiness(paths);
  expect(probe).toHaveBeenCalledTimes(1);
  config.auth = { kind: 'auth-json', env: 'FACTORY_READINESS_TEST_AUTH' };
  save();
  await codingReadiness(paths);
  expect(probe).toHaveBeenCalledTimes(1);
  vi.stubEnv(
    'FACTORY_READINESS_TEST_AUTH',
    '{"OPENAI_API_KEY":"synthetic-valid-json"}',
  );
  const result = await codingReadiness(paths);
  expect(probe).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(result)).not.toContain('synthetic');
  expect(JSON.stringify(result)).not.toContain('OPENAI_API_KEY');
});
it('valid-to-missing-to-valid auth invalidates a cached CLI failure without retaining credential values', async () => {
  await codingReadiness(paths);
  vi.stubEnv('FACTORY_READINESS_TEST_AUTH', '');
  await codingReadiness(paths);
  vi.stubEnv('FACTORY_READINESS_TEST_AUTH', 'different-synthetic-value');
  await codingReadiness(paths);
  expect(probe).toHaveBeenCalledTimes(2);
});
it('disabled readiness never probes and re-enabling retries without caching success', async () => {
  config.enabled = false;
  save();
  expect((await codingReadiness(paths)).enabled).toBe(false);
  config.enabled = true;
  save(false);
  expect((await codingReadiness(paths)).enabled).toBe(false);
  expect(probe).not.toHaveBeenCalled();
  save();
  probe.mockResolvedValue(supported);
  expect((await codingReadiness(paths)).ready).toBe(true);
  expect((await codingReadiness(paths)).ready).toBe(true);
  expect(probe).toHaveBeenCalledTimes(2);
});
it('drains concurrent old probes, discards stale success, and shares the retry for changed config', async () => {
  let settle!: (result: typeof supported) => void;
  probe.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  );
  const old = codingReadiness(paths);
  await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
  config.model = 'new-model';
  save();
  const newer = Promise.all([codingReadiness(paths), codingReadiness(paths)]);
  expect(probe).toHaveBeenCalledTimes(1);
  settle(supported);
  expect((await old).ready).toBe(false);
  expect((await newer).every((r) => !r.ready)).toBe(true);
  expect(probe).toHaveBeenCalledTimes(2);
});
it('does not return stale readiness when auth disappears during the probe', async () => {
  let settle!: (result: typeof supported) => void;
  probe.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  );
  const pending = codingReadiness(paths);
  await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
  vi.stubEnv('FACTORY_READINESS_TEST_AUTH', '');
  settle(supported);
  const result = await pending;
  expect(result.ready).toBe(false);
  expect(result.blockers).toContain(
    'Selected credential reference is unavailable or invalid.',
  );
  expect(probe).toHaveBeenCalledTimes(1);
});
it('does not cache unexpected probe IO rejection', async () => {
  probe.mockRejectedValueOnce(new Error('synthetic temporary IO error'));
  await expect(codingReadiness(paths)).rejects.toThrow(
    'synthetic temporary IO',
  );
  expect((await codingReadiness(paths)).ready).toBe(false);
  expect(probe).toHaveBeenCalledTimes(2);
});
it('bounds retained homes and allows an evicted failure to probe afresh', async () => {
  await codingReadiness(paths);
  const originalPaths = paths;
  for (let n = 0; n < 32; n++) {
    paths = runtimePaths(join(root, `other-${n}`));
    mkdirSync(paths.home);
    save();
    await codingReadiness(paths);
  }
  await codingReadiness(originalPaths);
  expect(probe).toHaveBeenCalledTimes(34);
});
it('rejects unknown adapters and malformed contract versions without a default fallback', () => {
  for (const adapter of [
    { id: 'unknown-cli', contractVersion: 1, cliVersion: '1' },
    { id: 'opencode', contractVersion: 2, cliVersion: '1' },
    { id: 'kilo', contractVersion: 1, cliVersion: '' },
    { id: 'codex', contractVersion: 1, cliVersion: '1', executable: '/other' },
  ])
    expect(v.safeParse(factoryCodingConfigSchema, { adapter }).success).toBe(
      false,
    );
  expect(v.parse(factoryCodingConfigSchema, {}).adapter).toBeNull();
});
it('reports readiness without claiming authenticated execution', async () => {
  probe.mockResolvedValue(supported);
  expect(await codingReadiness(paths)).toMatchObject({
    ready: true,
    status: 'ready',
    authentication: 'unverified',
  });
  config.enabled = false;
  save();
  expect(await codingReadiness(paths)).toMatchObject({
    ready: false,
    status: 'disabled',
  });
  config.enabled = true;
  config.model = null;
  save();
  expect(await codingReadiness(paths)).toMatchObject({
    ready: false,
    status: 'unconfigured',
  });
});

it('revalidates corrected adapter credentials at the same reference without retaining secret values', async () => {
  const adapter = codingRuns.getCodingAdapter('codex');
  const credentials = vi.fn<typeof adapter.credentials>(
    (selected, localConfig) => {
      if (selected?.value === '{}')
        throw new Error('synthetic adapter-invalid credentials');
      return adapter.credentials(selected, localConfig);
    },
  );
  const registered = vi
    .spyOn(codingRuns, 'getCodingAdapter')
    .mockReturnValue({ ...adapter, credentials });
  try {
    config.auth = { kind: 'auth-json', env: 'FACTORY_READINESS_TEST_AUTH' };
    save();
    vi.stubEnv('FACTORY_READINESS_TEST_AUTH', '{}');
    expect(await codingReadiness(paths)).toMatchObject({
      ready: false,
      status: 'credential-unavailable',
    });
    expect(probe).not.toHaveBeenCalled();
    probe.mockResolvedValue(supported);
    for (const key of ['synthetic-corrected-key', 'synthetic-rotated-key']) {
      vi.stubEnv(
        'FACTORY_READINESS_TEST_AUTH',
        JSON.stringify({ OPENAI_API_KEY: key }),
      );
      const result = await codingReadiness(paths);
      expect(result).toMatchObject({
        ready: true,
        authentication: 'unverified',
      });
      expect(JSON.stringify(result)).not.toContain(key);
    }
    expect(probe).toHaveBeenCalledTimes(2);
    expect(credentials).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'auth-json' }),
      expect.objectContaining({
        model: config.model,
        executable: config.executable,
      }),
    );
  } finally {
    registered.mockRestore();
  }
});

it('resolves local auth at readiness and launch, recovering missing files without leaking credentials', async () => {
  const path = join(root, 'auth.json');
  config.auth = { kind: 'codex-local', path };
  save();
  expect(await codingReadiness(paths)).toMatchObject({
    status: 'credential-unavailable',
    installedVersion: null,
  });
  expect(probe).not.toHaveBeenCalled();
  writeFileSync(path, '{}');
  expect((await codingReadiness(paths)).ready).toBe(false);
  expect(probe).not.toHaveBeenCalled();
  writeFileSync(
    path,
    '{"tokens":{"access_token":"synthetic-local-access","refresh_token":"synthetic-local-refresh"}}',
  );
  probe.mockResolvedValue(supported);
  const result = await codingReadiness(paths);
  expect(result).toMatchObject({ ready: true, authentication: 'unverified' });
  expect(JSON.stringify(result)).not.toContain('synthetic-local');
  rmSync(path);
  expect((await codingReadiness(paths)).status).toBe('credential-unavailable');
  expect(probe).toHaveBeenCalledTimes(1);
});
