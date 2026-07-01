import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadNeondeckEnv,
  parseDotEnv,
  quoteEnvValue,
  readEnvFiles,
} from './env';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';

const tempRoots: string[] = [];
const originalEnv = { ...process.env };

afterEach(async () => {
  process.env = { ...originalEnv };
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('neondeck env loading', () => {
  it('parses quoted dotenv values', () => {
    expect(
      parseDotEnv(`KILOCODE_API_KEY="secret value"
GITHUB_LOGIN=octo
`),
    ).toEqual(
      new Map([
        ['KILOCODE_API_KEY', 'secret value'],
        ['GITHUB_LOGIN', 'octo'],
      ]),
    );
  });

  it('round-trips escaped quoted dotenv values written by quoteEnvValue', () => {
    const value = 'secret "quoted" value with \\ slash';

    expect(parseDotEnv(`TOKEN=${quoteEnvValue(value)}\n`)).toEqual(
      new Map([['TOKEN', value]]),
    );
  });

  it('loads runtime-home env without overriding real process env', async () => {
    const home = await tempDir();
    const paths = runtimePaths(home);
    process.env.GITHUB_TOKEN = 'from-process';
    await ensureRuntimeHome(paths);
    await writeFile(
      paths.env,
      `GITHUB_TOKEN="from-runtime"
`,
    );

    const result = loadNeondeckEnv(paths, { includeDevFallback: false });

    expect(result.files[0]).toMatchObject({
      id: 'runtime',
      path: paths.env,
      loaded: true,
    });
    expect(process.env.GITHUB_TOKEN).toBe('from-process');
  });

  it('reads runtime-home env for diagnostics', async () => {
    const home = await tempDir();
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    await writeFile(
      paths.env,
      `GITHUB_TOKEN="from-runtime"
`,
    );

    await expect(
      readEnvFiles(paths, { includeDevFallback: false }),
    ).resolves.toEqual(new Map([['GITHUB_TOKEN', 'from-runtime']]));
  });
});

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), 'neondeck-env-'));
  tempRoots.push(path);
  return path;
}
