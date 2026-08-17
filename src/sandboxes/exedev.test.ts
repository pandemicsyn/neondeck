import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SshSandboxDriver,
  resolveAuth,
  sshSandboxFromDriver,
  type SshExecStream,
  type SshLike,
} from './exedev';
import type { SFTPWrapper, Stats } from 'ssh2';

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

  it('fails closed when an explicit SSH key is unreadable or ambient auth is disabled', () => {
    expect(() =>
      resolveAuth(
        { allowAmbientAuth: false },
        { EXE_SSH_KEY: '/definitely/missing/neondeck-key' },
      ),
    ).toThrow(/SSH private key.*not readable/);
    expect(() =>
      resolveAuth(
        { allowAmbientAuth: false, agent: '/tmp/ssh-agent.sock' },
        {},
      ),
    ).toThrow(/explicit.*private key/);
  });

  it('bounds remote command output inside the adapter', async () => {
    const ssh = new FakeSsh(Buffer.from('abcdefghijklmnop'));
    const api = new SshSandboxDriver(ssh, 8);

    await expect(api.exec('yes')).resolves.toMatchObject({
      stdout: 'abcdefgh',
      stderr: expect.stringContaining('Output exceeded 8 bytes'),
      exitCode: 124,
      uncertainty: { kind: 'output-limit' },
    });
  });

  it('reports target facts while preserving the path symlink flag', async () => {
    const pathStats = fakeStats({ symbolicLink: true, size: 7 });
    const targetStats = fakeStats({ file: true, size: 42 });
    const api = new SshSandboxDriver(new FakeSftpSsh(pathStats, targetStats));

    await expect(api.stat('/workspace/link')).resolves.toMatchObject({
      isFile: true,
      isDirectory: false,
      isSymbolicLink: true,
      size: 42,
    });
  });

  it('classifies a missing SSH exit status as orphan-possible transport uncertainty', async () => {
    const api = new SshSandboxDriver(new MissingStatusSsh());
    await expect(api.exec('test -f package.json')).resolves.toMatchObject({
      exitCode: 124,
      uncertainty: {
        kind: 'transport',
        message: expect.stringContaining('without an exit status'),
      },
    });
  });

  it('classifies a command stream error after launch as transport uncertainty', async () => {
    const api = new SshSandboxDriver(new StreamErrorSsh());
    await expect(api.exec('npm test')).resolves.toMatchObject({
      exitCode: 124,
      uncertainty: {
        kind: 'transport',
        message: expect.stringContaining('stream failed after launch'),
      },
    });
  });

  it('bounds structured writes and reports an unconfirmed timeout as typed uncertainty', async () => {
    const ssh = new HangingWriteSsh();
    const api = new SshSandboxDriver(ssh, 1024, 5, 4);
    await expect(api.writeFile('/workspace/a', 'oversized')).rejects.toThrow(
      /4-byte limit/,
    );
    await expect(api.writeFile('/workspace/a', 'okay')).rejects.toMatchObject({
      name: 'SshOperationUncertainError',
      uncertainty: { kind: 'timeout', operation: 'writeFile' },
    });
    const env = sshSandboxFromDriver(api, '/workspace');
    await expect(env.writeFile('nested/a', 'okay')).rejects.toMatchObject({
      name: 'SshOperationUncertainError',
    });
    expect(ssh.writeAttempts).toBe(2);
  });

  it('preserves factual ENOENT so the conforming Sandbox creates parents and retries once', async () => {
    const ssh = new MissingParentWriteSsh();
    const sandbox = sshSandboxFromDriver(
      new SshSandboxDriver(ssh, 1024, 100, 1024),
      '/workspace',
    );

    await expect(sandbox.writeFile('nested/report.txt', 'ok')).resolves.toBe(
      undefined,
    );
    expect(ssh.writeAttempts).toBe(2);
    expect(ssh.mkdirAttempts).toBe(1);
  });

  it('bounds and deadlines structured SSH reads', async () => {
    const bounded = new SshSandboxDriver(
      new ReadSsh(Buffer.from('too-large')),
      1024,
      100,
      1024,
      4,
    );
    await expect(bounded.readFile('/workspace/a')).rejects.toThrow(
      /4-byte limit/,
    );

    const hanging = new SshSandboxDriver(
      new ReadSsh(undefined),
      1024,
      5,
      1024,
      1024,
    );
    await expect(hanging.readFile('/workspace/a')).rejects.toThrow(
      /readFile timed out.*5 milliseconds/,
    );

    const metadata = new SshSandboxDriver(
      new HangingMetadataSsh(),
      1024,
      5,
      1024,
      1024,
    );
    await expect(metadata.stat('/workspace/a')).rejects.toThrow(
      /stat timed out.*5 milliseconds/,
    );
    await expect(metadata.readdir('/workspace')).rejects.toThrow(
      /readdir timed out.*5 milliseconds/,
    );
  });

  it('rejects recursive mkdir when the remote shell command fails', async () => {
    const api = new SshSandboxDriver(new NonZeroStatusSsh());
    await expect(
      api.mkdir('/workspace/read-only/nested', { recursive: true }),
    ).rejects.toThrow(
      /recursive directory creation.*read-only.*permission denied/i,
    );
  });

  it('deadlines recursive mkdir and preserves its uncertain settlement', async () => {
    const api = new SshSandboxDriver(new FakeSsh(Buffer.alloc(0)), 1024, 5);
    await expect(
      api.mkdir('/workspace/slow/nested', { recursive: true }),
    ).rejects.toMatchObject({
      name: 'SshOperationUncertainError',
      uncertainty: { kind: 'timeout', operation: 'mkdir' },
    });
  });

  it('forwards abort to the SSH channel and removes its listener on settlement', async () => {
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    const api = new SshSandboxDriver(new FakeSsh(Buffer.from('ok')));
    const result = api.exec('npm test', { signal: controller.signal });
    controller.abort();

    await expect(result).resolves.toMatchObject({
      exitCode: 124,
      uncertainty: { kind: 'abort' },
    });
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});

function fakeStats(input: {
  file?: boolean;
  directory?: boolean;
  symbolicLink?: boolean;
  size: number;
}) {
  return {
    size: input.size,
    mtime: 1_700_000_000,
    isFile: () => Boolean(input.file),
    isDirectory: () => Boolean(input.directory),
    isSymbolicLink: () => Boolean(input.symbolicLink),
  } as Stats;
}

class FakeSftpSsh implements SshLike {
  constructor(
    private pathStats: Stats,
    private targetStats: Stats,
  ) {}

  sftp(cb: (err: Error | undefined, sftp: SFTPWrapper) => void) {
    const events = new EventEmitter();
    cb(
      undefined,
      Object.assign(events, {
        lstat: (
          _path: string,
          done: (error: Error | undefined, stats: Stats) => void,
        ) => done(undefined, this.pathStats),
        stat: (
          _path: string,
          done: (error: Error | undefined, stats: Stats) => void,
        ) => done(undefined, this.targetStats),
      }) as unknown as SFTPWrapper,
    );
  }

  exec() {
    throw new Error('exec is not used by this test.');
  }
}

class MissingStatusSsh implements SshLike {
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
    queueMicrotask(() => stream.emit('close', undefined));
  }
}

class NonZeroStatusSsh implements SshLike {
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
      (stream.stderr as EventEmitter).emit(
        'data',
        Buffer.from('permission denied'),
      );
      stream.emit('close', 1);
    });
  }
}

class StreamErrorSsh implements SshLike {
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
    queueMicrotask(() => stream.emit('error', new Error('channel reset')));
  }
}

class HangingWriteSsh implements SshLike {
  writeAttempts = 0;

  sftp(cb: (err: Error | undefined, sftp: SFTPWrapper) => void) {
    const events = new EventEmitter();
    cb(
      undefined,
      Object.assign(events, {
        end: () => events.emit('close'),
        createWriteStream: () => {
          this.writeAttempts += 1;
          return Object.assign(new EventEmitter(), { end: () => undefined });
        },
      }) as unknown as SFTPWrapper,
    );
  }

  exec() {
    throw new Error('exec is not used by this test.');
  }
}

class MissingParentWriteSsh implements SshLike {
  writeAttempts = 0;
  mkdirAttempts = 0;

  sftp(cb: (err: Error | undefined, sftp: SFTPWrapper) => void) {
    const events = new EventEmitter();
    cb(
      undefined,
      Object.assign(events, {
        end: () => events.emit('close'),
        createWriteStream: () => {
          this.writeAttempts += 1;
          const attempt = this.writeAttempts;
          const stream = Object.assign(new EventEmitter(), {
            end: () => {
              if (attempt === 1) {
                const error = Object.assign(new Error('No such file'), {
                  code: 'ENOENT',
                });
                queueMicrotask(() => stream.emit('error', error));
              } else {
                queueMicrotask(() => stream.emit('close'));
              }
            },
          });
          return stream;
        },
      }) as unknown as SFTPWrapper,
    );
  }

  exec(
    _command: string,
    _options: object,
    cb: (err: Error | undefined, stream: SshExecStream) => void,
  ) {
    this.mkdirAttempts += 1;
    const stream = new FakeExecStream();
    cb(undefined, stream);
    queueMicrotask(() => stream.emit('close', 0));
  }
}

class ReadSsh implements SshLike {
  constructor(private content: Buffer | undefined) {}

  sftp(cb: (err: Error | undefined, sftp: SFTPWrapper) => void) {
    const events = new EventEmitter();
    cb(
      undefined,
      Object.assign(events, {
        end: () => events.emit('close'),
        createReadStream: () => {
          const stream = Object.assign(new EventEmitter(), {
            destroy: (error?: Error) => {
              if (error) queueMicrotask(() => stream.emit('error', error));
            },
          });
          if (this.content) {
            queueMicrotask(() => {
              stream.emit('data', this.content);
              stream.emit('end');
            });
          }
          return stream;
        },
      }) as unknown as SFTPWrapper,
    );
  }

  exec() {
    throw new Error('exec is not used by this test.');
  }
}

class HangingMetadataSsh implements SshLike {
  sftp(cb: (err: Error | undefined, sftp: SFTPWrapper) => void) {
    const events = new EventEmitter();
    cb(
      undefined,
      Object.assign(events, {
        end: () => events.emit('close'),
        lstat: () => undefined,
        stat: () => undefined,
        readdir: () => undefined,
      }) as unknown as SFTPWrapper,
    );
  }

  exec() {
    throw new Error('exec is not used by this test.');
  }
}

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
