import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultServerPort,
  resolvePackagedServerEntry,
  resolveServerPort,
} from './serve';

describe('server serve options', () => {
  it('uses the default API port when no override is present', () => {
    const previousPort = process.env.PORT;
    const previousNeondeckPort = process.env.NEONDECK_PORT;
    try {
      delete process.env.PORT;
      delete process.env.NEONDECK_PORT;
      expect(resolveServerPort(undefined)).toBe(defaultServerPort);
    } finally {
      restoreEnvValue('PORT', previousPort);
      restoreEnvValue('NEONDECK_PORT', previousNeondeckPort);
    }
  });

  it('accepts valid CLI and environment port values', () => {
    expect(resolveServerPort('3599')).toBe(3599);
    expect(resolveServerPort(4600)).toBe(4600);
  });

  it('rejects invalid ports with a controlled message', () => {
    expect(() => resolveServerPort('bogus')).toThrow('Port must be an integer');
    expect(() => resolveServerPort('70000')).toThrow('Port must be an integer');
  });

  it('resolves the packaged server entry without using caller cwd', () => {
    const previousCwd = process.cwd();
    const callerCwd = mkdtempSync(join(tmpdir(), 'neondeck-caller-cwd-'));
    try {
      process.chdir(callerCwd);
      const entry = resolvePackagedServerEntry({});

      expect(entry).not.toBe(join(callerCwd, 'dist', 'server.mjs'));
      expect(entry).toMatch(/dist\/server\.mjs$/);
    } finally {
      process.chdir(previousCwd);
      rmSync(callerCwd, { recursive: true, force: true });
    }
  });

  it('allows an explicit server entry override', () => {
    expect(
      resolvePackagedServerEntry({
        NEONDECK_SERVER_ENTRY: '/opt/neondeck/server.mjs',
      }),
    ).toBe('/opt/neondeck/server.mjs');
  });
});

function restoreEnvValue(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
