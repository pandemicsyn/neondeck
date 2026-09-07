import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtemp,
  writeFile,
  utimes,
  rm,
  truncate,
  symlink,
  realpath,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import * as v from 'valibot';
import {
  codingExecutableIdentitySchema,
  codingPinnedExecutableIdentitySchema,
} from '../../../shared/coding-adapters.ts';
import {
  executableIdentity,
  assertExecutableIdentity,
  maxCodingExecutableBytes,
} from './executable-identity.ts';
const folders: string[] = [];
const exec = promisify(execFile);
async function fixture(content = 'initial-binary') {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'coding-binary-')),
  );
  folders.push(directory);
  const file = join(directory, 'synthetic-cli');
  await writeFile(file, content, { mode: 0o700 });
  return file;
}
afterEach(async () => {
  for (const folder of folders.splice(0))
    await rm(folder, { recursive: true, force: true });
});
it('hashes exact executable contents with a stable canonical identity', async () => {
  const file = await fixture();
  const identity = await executableIdentity(file);
  expect(identity.sha256).toBe(
    createHash('sha256').update('initial-binary').digest('hex'),
  );
  await expect(
    assertExecutableIdentity(file, identity),
  ).resolves.toBeUndefined();
});
it('rejects same-inode same-size changes with the original modification time restored', async () => {
  const file = await fixture('version-one');
  const time = new Date('2026-01-01T00:00:00Z');
  await utimes(file, time, time);
  const expected = await executableIdentity(file);
  await writeFile(file, 'version-two');
  await utimes(file, time, time);
  const changed = await executableIdentity(file);
  expect({ ...changed, sha256: expected.sha256 }).toEqual(expected);
  expect(changed.sha256).not.toBe(expected.sha256);
  await expect(assertExecutableIdentity(file, expected)).rejects.toThrow(
    'identity changed',
  );
});
it('preserves old stat-only decoding but never repins a legacy identity for new execution', async () => {
  const file = await fixture();
  const { sha256: _digest, ...legacy } = await executableIdentity(file);
  expect(v.parse(codingExecutableIdentitySchema, legacy)).toEqual(legacy);
  expect(
    v.safeParse(codingPinnedExecutableIdentitySchema, legacy).success,
  ).toBe(false);
  await rm(file);
  await expect(assertExecutableIdentity(file, legacy)).rejects.toThrow(
    'lacks a content digest',
  );
});
it('rejects oversized sparse executables before hashing their content', async () => {
  const file = await fixture();
  await truncate(file, maxCodingExecutableBytes + 1);
  expect((await stat(file)).size).toBe(maxCodingExecutableBytes + 1);
  await expect(executableIdentity(file)).rejects.toThrow(
    'bounded regular file',
  );
});
it('rejects a no-writer FIFO without blocking descriptor acquisition', async () => {
  const file = await fixture();
  await rm(file);
  await exec('mkfifo', [file], { timeout: 1000, killSignal: 'SIGKILL' });
  const moduleUrl = new URL('./executable-identity.ts', import.meta.url).href;
  // Isolate the call: if nonblocking open regresses, SIGKILL bounds the child
  // instead of leaving a blocked filesystem request inside the Vitest worker.
  const { stdout } = await exec(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import assert from 'node:assert/strict';
     import { executableIdentity } from ${JSON.stringify(moduleUrl)};
     await assert.rejects(executableIdentity(process.argv[1]), /bounded regular file/);
     process.stdout.write('fifo-rejected');`,
      file,
    ],
    { timeout: 3000, killSignal: 'SIGKILL', maxBuffer: 4096 },
  );
  expect(stdout).toBe('fifo-rejected');
});
it('binds the canonical executable while rejecting a later symlink redirect', async () => {
  const first = await fixture('first');
  const second = await fixture('other');
  const link = join(folders[0], 'selected');
  await symlink(first, link);
  const expected = await executableIdentity(link);
  await rm(link);
  await symlink(second, link);
  await expect(assertExecutableIdentity(link, expected)).rejects.toThrow(
    'identity changed',
  );
});
