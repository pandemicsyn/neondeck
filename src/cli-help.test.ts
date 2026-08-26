import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('CLI help', () => {
  it('prints getting-started commands with no arguments', async () => {
    const result = await runCli([]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Getting started:');
    expect(result.output).toContain(
      '1. neondeck init  Run the first-time setup wizard.',
    );
    expect(result.output).toContain(
      '2. neondeck open  Start Neondeck and open the dashboard.',
    );
    expect(result.output.trimEnd()).toMatch(
      /Getting started:\n  1\. neondeck init  Run the first-time setup wizard\.\n  2\. neondeck open  Start Neondeck and open the dashboard\.$/,
    );
  });

  it.each([['--help'], ['help']])(
    'keeps explicit help focused on command reference for %s',
    async (arg) => {
      const result = await runCli([arg]);

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Usage: neondeck [options] [command]');
      expect(result.output).not.toContain('Getting started:');
    },
  );
});

async function runCli(args: string[]) {
  try {
    const result = await execFileAsync(
      process.execPath,
      ['bin/neondeck.mjs', ...args],
      { cwd: resolve('.') },
    );
    return { exitCode: 0, output: result.stdout + result.stderr };
  } catch (error) {
    const result = error as { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: result.code,
      output: (result.stdout ?? '') + (result.stderr ?? ''),
    };
  }
}
