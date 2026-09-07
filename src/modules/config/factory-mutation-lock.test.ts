import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import {
  FactoryMutationLockError,
  withFactoryMutationLock,
} from './factory-mutation-lock';
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(
    join(
      process.platform === 'darwin' ? '/private/tmp' : tmpdir(),
      'factory-lock-test-',
    ),
  );
  homes.push(home);
  const config = join(home, 'config.json');
  writeFileSync(config, '{}');
  return config;
}
it('rejects a lock acquired by another process and never steals an abandoned lock', () => {
  const config = fixture();
  execFileSync(process.execPath, [
    '-e',
    'require("node:fs").mkdirSync(process.argv[1])',
    `${config}.factory-write.lock`,
  ]);
  expect(() =>
    withFactoryMutationLock(config, () => {
      throw new Error('must not execute');
    }),
  ).toThrow(FactoryMutationLockError);
  expect(() => withFactoryMutationLock(config, () => 1)).toThrow(
    'stop all Neondeck processes before removing config.json.factory-write.lock',
  );
  expect(existsSync(`${config}.factory-write.lock`)).toBe(true);
});
it('releases ownership after success and failure', () => {
  const config = fixture();
  expect(withFactoryMutationLock(config, () => 42)).toBe(42);
  expect(() =>
    withFactoryMutationLock(config, () => {
      throw new Error('operation failed');
    }),
  ).toThrow('operation failed');
  expect(existsSync(`${config}.factory-write.lock`)).toBe(false);
});

it('blocks a simultaneous second process while the first writer is alive', async () => {
  const config = fixture();
  const child = spawn(
    process.execPath,
    [
      '-e',
      'require("node:fs").mkdirSync(process.argv[1]); process.send("locked"); setInterval(() => {}, 1000);',
      `${config}.factory-write.lock`,
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('message', () => resolve());
      child.once('error', reject);
      child.once('exit', () => reject(new Error('writer exited before ready')));
    });
    expect(child.exitCode).toBeNull();
    expect(() => withFactoryMutationLock(config, () => 1)).toThrow(
      'locked by another writer',
    );
  } finally {
    const exited = new Promise<void>((resolve) =>
      child.once('exit', () => resolve()),
    );
    child.kill();
    await exited;
  }
});
it('preserves the mutation error when cleanup also fails', () => {
  const config = fixture();
  expect(() =>
    withFactoryMutationLock(config, () => {
      writeFileSync(`${config}.factory-write.lock/attention`, 'synthetic');
      throw new Error('original mutation failure');
    }),
  ).toThrow('original mutation failure');
  expect(existsSync(`${config}.factory-write.lock`)).toBe(true);
});
