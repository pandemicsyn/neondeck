import { spawn } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  readFile,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { build } from 'vite';
import {
  artifactHash,
  atomicWrite,
  writeSigned,
  readSigned,
} from '../coding-runs';
import {
  cancelCandidateVerification,
  runSupervisedCandidateCheck,
} from './verification-supervisor';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'verification-worker-test-')),
  );
  roots.push(root);
  const directory = join(root, 'attempt');
  await mkdir(directory, { mode: 0o700 });
  return { root, handle: { directory, attemptToken: 'e'.repeat(64) } };
}
async function until<T>(fn: () => Promise<T>) {
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((r) => setTimeout(r, 30));
    }
  }
}
it('retains one supervised job and rejects changed replay/cancel before launch', async () => {
  const { handle } = await fixture();
  const input = {
    command: '/usr/bin/true',
    cwd: handle.directory,
    timeoutMs: 1000,
    maxOutputBytes: 1000,
  };
  const first = await runSupervisedCandidateCheck(input, handle, 'one');
  expect(first).toMatchObject({ exitCode: 0, noWriter: true });
  expect(await runSupervisedCandidateCheck(input, handle, 'one')).toEqual(
    first,
  );
  await expect(
    runSupervisedCandidateCheck(
      { ...input, command: '/usr/bin/false' },
      handle,
      'one',
    ),
  ).rejects.toThrow('payload mismatch');
  await cancelCandidateVerification(handle, 'cancelled');
  await expect(
    runSupervisedCandidateCheck(input, handle, 'cancelled'),
  ).rejects.toThrow('cancelled');
});
it('worker enforces timeout after its Neon controller is killed', async () => {
  const { handle } = await fixture();
  const moduleUrl = pathToFileURL(
    resolve('src/modules/factory-delivery/verification-supervisor.ts'),
  ).href;
  const code = `import {runSupervisedCandidateCheck} from ${JSON.stringify(moduleUrl)}; await runSupervisedCandidateCheck({command:'/bin/sleep 10',cwd:${JSON.stringify(handle.directory)},timeoutMs:500,maxOutputBytes:1000},${JSON.stringify(handle)},'controller-loss');`;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', code],
    { cwd: process.cwd(), stdio: 'ignore' },
  );
  const directory = join(
    handle.directory,
    `check-${artifactHash('controller-loss')}`,
  );
  try {
    await until(() => readFile(join(directory, 'started.json')));
    child.kill('SIGKILL');
    const receipt = await until(() =>
      readSigned(join(directory, 'terminal.json'), handle.attemptToken),
    );
    expect(receipt).toMatchObject({
      jobId: 'controller-loss',
      result: { timedOut: true, noWriter: true, exitCode: null },
    });
  } finally {
    child.kill('SIGKILL');
  }
});
it('runs built worker from a node_modules package path without TypeScript loader', async () => {
  const { root, handle } = await fixture();
  const packageRoot = join(root, 'node_modules', 'neondeck');
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await symlink(resolve('node_modules'), join(packageRoot, 'node_modules'));
  const worker = join(packageRoot, 'dist', 'verification-worker.mjs');
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      ssr: resolve('src/modules/factory-delivery/verification-worker.ts'),
      outDir: join(packageRoot, 'dist'),
      emptyOutDir: false,
      minify: false,
      rollupOptions: {
        output: {
          entryFileNames: 'verification-worker.mjs',
          codeSplitting: false,
        },
      },
    },
  });
  const directory = join(handle.directory, 'packaged');
  await mkdir(directory, { mode: 0o700 });
  const job = {
    jobId: 'packaged',
    cancellationId: 'packaged',
    request: {
      command: '/usr/bin/true',
      cwd: handle.directory,
      timeoutMs: 1000,
      maxOutputBytes: 1000,
    },
  };
  await atomicWrite(join(directory, 'token'), handle.attemptToken);
  await writeSigned(join(directory, 'request.json'), handle.attemptToken, job);
  const child = spawn(process.execPath, [worker, directory], {
    cwd: packageRoot,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (b) => {
    stderr += b.toString();
  });
  const exit = await new Promise((resolve) => child.once('exit', resolve));
  expect(stderr).not.toContain('ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING');
  if (exit !== 0) throw new Error(`Packaged worker failed: ${stderr}`);
  expect(exit).toBe(0);
  expect(
    await readSigned(join(directory, 'terminal.json'), handle.attemptToken),
  ).toMatchObject({
    jobId: 'packaged',
    result: { exitCode: 0, noWriter: true },
  });
});

it('durable cancellation stops an already admitted check', async () => {
  const { handle } = await fixture();
  const pending = runSupervisedCandidateCheck(
    {
      command: '/bin/sleep 10',
      cwd: handle.directory,
      timeoutMs: 5000,
      maxOutputBytes: 1000,
    },
    handle,
    'cancel-active',
  );
  await until(() =>
    readFile(
      join(
        handle.directory,
        `check-${artifactHash('cancel-active')}`,
        'started.json',
      ),
    ),
  );
  await cancelCandidateVerification(handle, 'cancel-active');
  expect(await pending).toMatchObject({
    cancelled: true,
    noWriter: true,
    exitCode: null,
  });
});
