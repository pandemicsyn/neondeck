import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ExeDevSandboxApi,
  isRetryableSshError,
  parseVmResponse,
  resolveAuth,
  type SshExecStream,
} from './exedev';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('exe.dev sandbox adapter', () => {
  it('prefers an explicit private key path over an SSH agent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neondeck-exedev-'));
    tempRoots.push(root);
    const keyPath = join(root, 'id_ed25519');
    await writeFile(keyPath, 'test-key');

    expect(
      resolveAuth(
        {
          privateKeyPath: keyPath,
          agent: '/tmp/ssh-agent.sock',
        },
        {},
      ),
    ).toEqual({
      privateKey: Buffer.from('test-key'),
    });
  });

  it('bounds remote command output inside the adapter', async () => {
    const ssh = new FakeSsh(Buffer.from('abcdefghijklmnop'));
    const api = new ExeDevSandboxApi(ssh, 8);

    await expect(api.exec('yes')).resolves.toMatchObject({
      stdout: 'abcdefgh',
      stderr: expect.stringContaining('Output exceeded 8 bytes'),
      exitCode: 124,
    });
  });

  it('retains valid VM fields when optional API fields are null', () => {
    expect(
      parseVmResponse(JSON.stringify({ vm_name: 'worker-1', ssh_port: null })),
    ).toEqual({
      name: 'worker-1',
      host: 'worker-1.exe.xyz',
      port: undefined,
    });
  });

  it('retries socket errors whose numeric errno accompanies a valid code', () => {
    expect(
      isRetryableSshError({
        code: 'ECONNREFUSED',
        errno: -61,
        message: 'connect ECONNREFUSED',
      }),
    ).toBe(true);
  });
});

class FakeSsh {
  constructor(private output: Buffer) {}

  sftp() {
    throw new Error('SFTP is not used by this test.');
  }

  exec(
    _command: string,
    _options: object,
    cb: (err: Error | undefined, stream: SshExecStream) => void,
  ) {
    const stream = new FakeExecStream();
    cb(undefined, stream);
    queueMicrotask(() => {
      stream.emit('data', this.output);
    });
  }
}

class FakeExecStream extends EventEmitter implements SshExecStream {
  stderr = new EventEmitter() as SshExecStream['stderr'];

  close(): void {
    this.emit('close', 124);
  }
}
