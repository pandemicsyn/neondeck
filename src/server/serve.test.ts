import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultServerPort,
  formatServerStop,
  resolvePackagedServerEntry,
  resolveServerPort,
  rewriteServerLogLine,
  serverSignalExitCode,
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

  it('replaces the framework startup banner with Neondeck launch details', () => {
    expect(
      rewriteServerLogLine(
        '[flue] Server listening on http://localhost:3583',
        3583,
        '/home/alice/.config/neondeck',
      ),
    ).toBe(
      [
        '[neondeck] Server ready',
        '  dashboard  http://127.0.0.1:3583/',
        '  home       /home/alice/.config/neondeck',
        '  mode       foreground (Ctrl+C to stop)',
      ].join('\n'),
    );
  });

  it('preserves ordinary server output', () => {
    expect(rewriteServerLogLine('[neondeck] scheduler started', 3583)).toBe(
      '[neondeck] scheduler started',
    );
  });

  it('formats server shutdown outcomes', () => {
    expect(formatServerStop(0, null)).toBe('[neondeck] Server stopped code=0');
    expect(formatServerStop(null, 'SIGTERM')).toBe(
      '[neondeck] Server stopped signal=SIGTERM',
    );
    expect(serverSignalExitCode('SIGINT')).toBe(130);
    expect(serverSignalExitCode('SIGTERM')).toBe(143);
  });
});

function restoreEnvValue(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
