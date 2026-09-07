import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  codingExecutionPath,
  discoverCodingExecutable,
  isCodingExecutable,
  validCodingPath,
} from './coding-discovery';
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});
it('detects executable symlinks from sanitized PATH and conventional directories', async () => {
  const home = await mkdtemp(join(tmpdir(), 'coding-discovery-'));
  homes.push(home);
  const bin = join(home, '.local/bin');
  await mkdir(bin, { recursive: true });
  const file = join(home, 'wrapper');
  await writeFile(file, '#!/usr/bin/env node\n', { mode: 0o755 });
  await symlink(file, join(bin, 'codex'));
  const context = {
    home,
    node: process.execPath,
    env: {
      PATH: ':relative:~/bin:/bad\npath:/usr/bin:/usr/bin',
      PRIVATE_SECRET: 'synthetic',
    },
  };
  expect(await discoverCodingExecutable('codex', context)).toBe(
    join(bin, 'codex'),
  );
  const path = codingExecutionPath(join(bin, 'codex'), context).split(':');
  expect(path[0]).toBe(bin);
  expect(path).toContain(dirname(process.execPath));
  expect(new Set(path).size).toBe(path.length);
  expect(path).not.toContain('relative');
  expect(path.join(':')).not.toContain('synthetic');
  await chmod(file, 0o644);
  expect(await isCodingExecutable(join(bin, 'codex'))).toBe(false);
  expect(await isCodingExecutable(bin)).toBe(false);
  expect(await isCodingExecutable(join(home, 'missing'))).toBe(false);
  expect(await discoverCodingExecutable('../wrapper', context)).toBeUndefined();
});
it('rejects empty, relative and control-character PATH entries', () => {
  for (const path of [
    '',
    '/bin:',
    ':/bin',
    '/bin::/usr/bin',
    'relative',
    '~/bin',
    '/bin\n',
  ])
    expect(validCodingPath(path)).toBe(false);
  expect(validCodingPath('/opt/node/bin:/usr/bin:/bin')).toBe(true);
});
