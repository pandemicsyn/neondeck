import { describe, expect, it } from 'vitest';
import type { Sandbox as TensorlakeSandbox } from 'tensorlake';
import { TensorlakeSandboxDriver, tensorlake } from './index.js';

interface RunCall {
  args?: string[];
  command: string;
  options?: Record<string, unknown>;
}

class FakeTensorlakeSandbox {
  readonly runCalls: RunCall[] = [];
  readonly writes: Array<{ content: Uint8Array; path: string }> = [];
  files = new Map<string, Uint8Array>();
  entries = [{ name: 'alpha' }, { name: 'beta' }];
  nextResult = { exitCode: 0, stderr: '', stdout: '' };
  results: Array<{ exitCode: number; stderr: string; stdout: string }> = [];

  async run(command: string, options?: Record<string, unknown>) {
    this.runCalls.push({
      args: options?.args as string[] | undefined,
      command,
      options,
    });
    return this.results.shift() ?? this.nextResult;
  }

  async readFile(filePath: string): Promise<Uint8Array> {
    const content = this.files.get(filePath);
    if (!content) throw new Error(`Not found: ${filePath}`);
    return content;
  }

  async writeFile(filePath: string, content: Uint8Array): Promise<void> {
    const stored = new Uint8Array(content);
    this.files.set(filePath, stored);
    this.writes.push({ content: stored, path: filePath });
  }

  async listDirectory(
    path: string,
  ): Promise<{ entries: Array<{ name: string }>; path: string }> {
    return { entries: this.entries, path };
  }
}

function asTensorlakeSandbox(fake: FakeTensorlakeSandbox): TensorlakeSandbox {
  return fake as unknown as TensorlakeSandbox;
}

describe('TensorlakeSandboxDriver', () => {
  it('runs Flue shell commands with cwd, env, and rounded-up timeout', async () => {
    const fake = new FakeTensorlakeSandbox();
    fake.nextResult = { exitCode: 7, stderr: 'failed', stdout: 'partial' };
    const driver = new TensorlakeSandboxDriver(asTensorlakeSandbox(fake));

    await expect(
      driver.exec('echo $MESSAGE', {
        cwd: '/project',
        env: { MESSAGE: 'hello' },
        timeoutMs: 1_001,
      }),
    ).resolves.toEqual({ exitCode: 7, stderr: 'failed', stdout: 'partial' });

    expect(fake.runCalls).toEqual([
      {
        args: ['-lc', 'echo $MESSAGE'],
        command: 'bash',
        options: {
          args: ['-lc', 'echo $MESSAGE'],
          env: { MESSAGE: 'hello' },
          timeout: 2,
          workingDir: '/project',
        },
      },
    ]);
  });

  it('reads and writes text and binary content with Tensorlake file APIs', async () => {
    const fake = new FakeTensorlakeSandbox();
    const driver = new TensorlakeSandboxDriver(asTensorlakeSandbox(fake));
    fake.files.set('/workspace/text.txt', new TextEncoder().encode('hello'));
    fake.files.set('/workspace/data.bin', new Uint8Array([0, 255, 42]));

    await expect(driver.readFile('/workspace/text.txt')).resolves.toBe('hello');
    await expect(driver.readFileBuffer('/workspace/data.bin')).resolves.toEqual(
      new Uint8Array([0, 255, 42]),
    );
    await driver.writeFile('/workspace/next.txt', 'next');
    await driver.writeFile('/workspace/next.bin', new Uint8Array([1, 2, 3]));

    expect(fake.writes).toEqual([
      {
        content: new TextEncoder().encode('next'),
        path: '/workspace/next.txt',
      },
      { content: new Uint8Array([1, 2, 3]), path: '/workspace/next.bin' },
    ]);
  });

  it('lists directory entry names through Tensorlake', async () => {
    const fake = new FakeTensorlakeSandbox();
    const driver = new TensorlakeSandboxDriver(asTensorlakeSandbox(fake));

    await expect(driver.readdir('/workspace')).resolves.toEqual([
      'alpha',
      'beta',
    ]);
  });

  it('uses argv-based commands for filesystem operations and parses stat', async () => {
    const fake = new FakeTensorlakeSandbox();
    const driver = new TensorlakeSandboxDriver(asTensorlakeSandbox(fake));
    const path = '/workspace/$(unexpected); --dash\nname';

    fake.nextResult = {
      exitCode: 0,
      stderr: '',
      stdout: '81a4\t42\t1700000000',
    };
    await expect(driver.stat(path)).resolves.toMatchObject({
      isDirectory: false,
      isFile: true,
      isSymbolicLink: false,
      size: 42,
    });
    await driver.mkdir(path, { recursive: true });
    await driver.rm(path, { force: true, recursive: true });

    expect(fake.runCalls).toEqual([
      {
        args: ['--printf=%f\\t%s\\t%Y', '--', path],
        command: 'stat',
        options: { args: ['--printf=%f\\t%s\\t%Y', '--', path] },
      },
      {
        args: ['-p', '--', path],
        command: 'mkdir',
        options: { args: ['-p', '--', path] },
      },
      {
        args: ['-r', '-f', '--', path],
        command: 'rm',
        options: { args: ['-r', '-f', '--', path] },
      },
    ]);
  });

  it('recognizes an empty regular file from its numeric mode', async () => {
    const fake = new FakeTensorlakeSandbox();
    const driver = new TensorlakeSandboxDriver(asTensorlakeSandbox(fake));
    fake.nextResult = {
      exitCode: 0,
      stderr: '',
      stdout: '81a4\t0\t1700000000',
    };

    await expect(driver.stat('/workspace/empty')).resolves.toMatchObject({
      isDirectory: false,
      isFile: true,
      isSymbolicLink: false,
      size: 0,
    });
  });

  it('returns false when stat cannot establish that a path exists', async () => {
    const fake = new FakeTensorlakeSandbox();
    const driver = new TensorlakeSandboxDriver(asTensorlakeSandbox(fake));
    fake.nextResult = { exitCode: 1, stderr: 'not found', stdout: '' };

    await expect(driver.exists('/missing')).resolves.toBe(false);
    fake.nextResult = { exitCode: 2, stderr: 'connection failed', stdout: '' };
    await expect(driver.exists('/workspace')).resolves.toBe(false);
  });

  it('reports symlink metadata from the target while retaining link identity', async () => {
    const fake = new FakeTensorlakeSandbox();
    const driver = new TensorlakeSandboxDriver(asTensorlakeSandbox(fake));
    fake.results = [
      { exitCode: 0, stderr: '', stdout: 'a1ff\t9\t1700000000' },
      { exitCode: 0, stderr: '', stdout: '41ed\t4096\t1700000001' },
    ];

    await expect(driver.stat('/workspace/current')).resolves.toEqual({
      isDirectory: true,
      isFile: false,
      isSymbolicLink: true,
      mtime: new Date(1_700_000_001_000),
      size: 4096,
    });
    expect(fake.runCalls).toEqual([
      {
        args: ['--printf=%f\\t%s\\t%Y', '--', '/workspace/current'],
        command: 'stat',
        options: {
          args: ['--printf=%f\\t%s\\t%Y', '--', '/workspace/current'],
        },
      },
      {
        args: ['-L', '--printf=%f\\t%s\\t%Y', '--', '/workspace/current'],
        command: 'stat',
        options: {
          args: ['-L', '--printf=%f\\t%s\\t%Y', '--', '/workspace/current'],
        },
      },
    ]);
  });
});

describe('tensorlake', () => {
  it('creates Flue sandboxes with the default and configured cwd', async () => {
    const fake = new FakeTensorlakeSandbox();
    const defaultSandbox = await tensorlake(
      asTensorlakeSandbox(fake),
    ).createSandbox({
      id: 'default',
    });
    const customSandbox = await tensorlake(asTensorlakeSandbox(fake), {
      cwd: '/project',
    }).createSandbox({ id: 'custom' });

    expect(defaultSandbox.cwd).toBe('/workspace');
    expect(customSandbox.cwd).toBe('/project');
  });
});
