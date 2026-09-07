import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import { factoryCodingConfigSchema } from '../../../shared/factory-coding';
import { discoverLocalCodexAuth, readLocalCodexAuth } from './codex-local-auth';
import { selectedCodingAuth } from './coding-readiness';
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    fstatSync: vi.fn<typeof actual.fstatSync>(actual.fstatSync),
  };
});
let root: string;
let path: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'synthetic-local-auth-'));
  path = join(root, 'auth.json');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
it('discovers only the selected known file and returns references without secrets', () => {
  mkdirSync(join(root, '.codex'));
  writeFileSync(
    join(root, '.codex/auth.json'),
    '{"OPENAI_API_KEY":"synthetic-key"}',
  );
  expect(discoverLocalCodexAuth({ env: {}, home: root })).toEqual({
    available: true,
    path: join(root, '.codex/auth.json'),
    reason: null,
  });
  expect(
    discoverLocalCodexAuth({ env: { CODEX_HOME: root }, home: root }),
  ).toMatchObject({ available: false, path });
  writeFileSync(
    path,
    '{"tokens":{"access_token":"synthetic-access","refresh_token":"synthetic-refresh","id_token":"synthetic-id"}}',
  );
  const result = discoverLocalCodexAuth({
    env: { CODEX_HOME: root },
    home: root,
  });
  expect(result).toEqual({ available: true, path, reason: null });
  expect(JSON.stringify(result)).not.toContain('synthetic-access');
});
it.each([
  '{}',
  '[]',
  'null',
  '{"tokens":{}}',
  '{"tokens":{"refresh_token":"synthetic-only"}}',
  '{"OPENAI_API_KEY":" "}',
  '{"OPENAI_API_KEY":3}',
  '{"tokens":{"access_token":"ok","refresh_token":3}}',
  'synthetic malformed secret',
  'x'.repeat(131073),
])('rejects unusable content without disclosing it (#%#)', (contents) => {
  writeFileSync(path, contents);
  expect(() => readLocalCodexAuth(path)).toThrow(
    'Local Codex auth.json is unavailable or invalid.',
  );
  expect(
    discoverLocalCodexAuth({ env: { CODEX_HOME: root } }).reason,
  ).not.toContain('synthetic');
});
it('rejects relative paths, directories and symlinks without following them', () => {
  expect(() => readLocalCodexAuth('auth.json')).toThrow(
    'unavailable or invalid',
  );
  mkdirSync(path);
  expect(() => readLocalCodexAuth(path)).toThrow('unavailable or invalid');
  rmSync(path, { recursive: true });
  const target = join(root, 'other.json');
  writeFileSync(target, '{"OPENAI_API_KEY":"synthetic"}');
  symlinkSync(target, path);
  expect(() => readLocalCodexAuth(path)).toThrow('unavailable or invalid');
});
it('keeps config reference-only and resolves fresh isolated payloads for Codex only', () => {
  const config = v.parse(factoryCodingConfigSchema, {
    auth: { kind: 'codex-local', path },
  });
  expect(config.enabled).toBe(false);
  for (const key of ['synthetic-first', 'synthetic-rotated']) {
    const value = JSON.stringify({ OPENAI_API_KEY: key });
    writeFileSync(path, value);
    expect(selectedCodingAuth(config)).toEqual({ kind: 'auth-json', value });
    expect(JSON.stringify(config)).not.toContain(key);
  }
  config.adapter = {
    id: 'opencode',
    contractVersion: 1,
    cliVersion: 'fixture',
  };
  expect(() => selectedCodingAuth(config)).toThrow('require the Codex adapter');
  rmSync(path);
  config.adapter = null;
  expect(() => selectedCodingAuth(config)).toThrow('Keyring-only');
  expect(
    v.safeParse(factoryCodingConfigSchema, {
      auth: { kind: 'codex-local', path: 'auth.json' },
    }).success,
  ).toBe(false);
  expect(
    v.safeParse(factoryCodingConfigSchema, {
      auth: { kind: 'codex-local', path, value: 'secret' },
    }).success,
  ).toBe(false);
});

it('rejects a FIFO without waiting for a writer', () => {
  execFileSync('/usr/bin/mkfifo', [path]);
  expect(() => readLocalCodexAuth(path)).toThrow('unavailable or invalid');
});
it('bounds the actual read even when metadata understates the file size', () => {
  writeFileSync(
    path,
    JSON.stringify({ OPENAI_API_KEY: 'synthetic' }) + ' '.repeat(131073),
  );
  const stat = fs.statSync(path);
  const stamp = vi
    .mocked(fs.fstatSync)
    .mockReturnValueOnce(Object.assign(stat, { size: 1 }));
  try {
    expect(() => readLocalCodexAuth(path)).toThrow('unavailable or invalid');
  } finally {
    stamp.mockRestore();
  }
});
