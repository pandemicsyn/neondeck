import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultAppConfig } from './defaults';
import { ensureRuntimeHome, ensureRuntimeHomeSync } from './bootstrap';
import { runtimePaths } from './paths';
import { parseAppConfig } from './schemas';
import { readFeatures, resolveFeatures } from './features';

const homes: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

it.each([undefined, '', 'false', '0', 'yes', 'tru'])(
  'defaults factory off for env value %s',
  (value) => {
    expect(
      resolveFeatures(defaultAppConfig({ NEONDECK_FACTORY_ENABLED: value })),
    ).toEqual({ factory: false });
  },
);
it.each(['true', '1', ' TRUE '])('opts in for env value %s', (value) => {
  expect(
    resolveFeatures(defaultAppConfig({ NEONDECK_FACTORY_ENABLED: value })),
  ).toEqual({ factory: true });
});
it('does not infer the feature from existing intake or coding settings', () => {
  expect(
    resolveFeatures(
      parseAppConfig(
        {
          version: 1,
          factory: { enabled: true, coding: { enabled: true } },
        },
        'config.json',
      ),
    ),
  ).toEqual({ factory: false });
  expect(() =>
    parseAppConfig(
      { version: 1, features: { factory: 'true' } },
      'config.json',
    ),
  ).toThrow('config.json');
});
it.each([ensureRuntimeHome, ensureRuntimeHomeSync])(
  'seeds once and honors saved config on subsequent initialization (%#)',
  async (ensure) => {
    const home = await mkdtemp(join(tmpdir(), 'factory-feature-'));
    homes.push(home);
    const paths = runtimePaths(home);
    vi.stubEnv('NEONDECK_FACTORY_ENABLED', 'true');
    await ensure(paths);
    expect(readFeatures(paths)).toEqual({ factory: true });
    vi.stubEnv('NEONDECK_FACTORY_ENABLED', 'false');
    await ensure(paths);
    expect(readFeatures(paths)).toEqual({ factory: true });
    const config = JSON.parse(await readFile(paths.config, 'utf8'));
    await writeFile(
      paths.config,
      JSON.stringify({ ...config, features: { factory: false } }),
    );
    vi.stubEnv('NEONDECK_FACTORY_ENABLED', 'true');
    await ensure(paths);
    expect(readFeatures(paths)).toEqual({ factory: false });
    delete config.features;
    await writeFile(paths.config, JSON.stringify(config));
    await ensure(paths);
    expect(readFeatures(paths)).toEqual({ factory: false });
    expect(
      JSON.parse(await readFile(paths.config, 'utf8')).features,
    ).toBeUndefined();
  },
);
