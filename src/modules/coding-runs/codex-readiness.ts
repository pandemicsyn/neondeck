import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as v from 'valibot';
import { configSchema } from './host-contract.ts';
const exec = promisify(execFile);
export async function inspectCodexReadiness(input: unknown, home: string) {
  const config = v.parse(configSchema, input);
  try {
    const { stdout } = await exec(config.executable, ['--version'], {
      cwd: home,
      timeout: 5000,
      maxBuffer: 4096,
      env: {
        PATH: config.path,
        HOME: home,
        CODEX_HOME: home,
        XDG_CONFIG_HOME: home,
        LANG: 'C',
        NO_COLOR: '1',
      },
    });
    const version = v.parse(
      v.pipe(v.string(), v.maxLength(256)),
      stdout.trim(),
    );
    const expected = config.mockScenario
      ? 'mockdex codex-contract 0.150.1'
      : 'codex-cli 0.150.1';
    return version === expected
      ? { ready: true, version, reason: null }
      : { ready: false, version, reason: 'unsupported-cli-version' };
  } catch {
    return { ready: false, version: null, reason: 'cli-unavailable' };
  }
}
