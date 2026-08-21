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

  it('preserves output from normal nonzero exits with a null signal', () => {
    const error = normalizeExecFileError({
      message: 'exited with code 2',
      code: 2,
      signal: null,
      stdout: 'out',
      stderr: 'err',
      killed: false,
    });

    expect(error).toMatchObject({
      message: 'exited with code 2',
      code: 2,
      signal: null,
      stdout: 'out',
      stderr: 'err',
      timedOut: false,
    });
  });

  it('preserves valid diagnostics when one exec error field is malformed', () => {
    const error = normalizeExecFileError({
      message: 'spawn failed',
      code: 'ENOENT',
      signal: 'SIG_NOT_FROM_NODE_TYPES',
      stdout: null,
      stderr: 'command not found',
      killed: false,
    });

    expect(error).toMatchObject({
      message: 'spawn failed',
      code: 'ENOENT',
      signal: null,
      stdout: '',
      stderr: 'command not found',
      timedOut: false,
    });
  });
});
