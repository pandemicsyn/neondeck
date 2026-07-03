import { describe, expect, it } from 'vitest';
import { ExecFileError, normalizeExecFileError, runExecFile } from './exec';

describe('exec helpers', () => {
  it('returns stdout and stderr from a successful command', async () => {
    const result = await runExecFile(process.execPath, [
      '-e',
      'process.stdout.write("out"); process.stderr.write("err");',
    ]);

    expect(result).toEqual({ stdout: 'out', stderr: 'err' });
  });

  it('normalizes execFile errors', () => {
    const error = normalizeExecFileError(
      {
        message: 'failed',
        code: 2,
        stdout: Buffer.from('out'),
        stderr: 'err',
        killed: true,
        signal: 'SIGTERM',
      },
      'demo',
      ['arg'],
    );

    expect(error).toBeInstanceOf(ExecFileError);
    expect(error).toMatchObject({
      message: 'failed',
      code: 2,
      signal: 'SIGTERM',
      stdout: 'out',
      stderr: 'err',
      timedOut: true,
    });
  });
});
