import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { parseProcessTable } from './host-process.ts';
import { identitySchema } from './host-contract.ts';

describe('bounded process observations', () => {
  it('accepts Linux kernel group zero without weakening owned identities', () => {
    const rows = parseProcessTable(
      [
        '      2       0 Sat Jul 25 00:11:58 2026 S    [kthreadd]',
        '     10       0 Sat Jul 25 00:11:58 2026 I<   [kworker/0:0H-kblockd]',
        '    123     123 Sun Sep  6 00:11:58 2026 S    node local-anchor.ts nonce',
        '    124     123 Sun Sep  6 00:11:58 2026 Z    [node] <defunct>',
      ].join('\n'),
    );
    expect(rows.map((row) => row.pgid)).toEqual([0, 0, 123, 123]);
    expect(rows[3].zombie).toBe(true);
    const { zombie: _kernelZombie, ...kernel } = rows[0];
    const { zombie: _ownerZombie, ...owner } = rows[2];
    expect(v.safeParse(identitySchema, kernel).success).toBe(false);
    expect(v.parse(identitySchema, owner)).toMatchObject({
      pid: 123,
      pgid: 123,
    });
  });
  it.each([
    '0 0 Sat Jul 25 00:11:58 2026 S invalid-pid',
    '2 -1 Sat Jul 25 00:11:58 2026 S invalid-group',
    '2 2147483648 Sat Jul 25 00:11:58 2026 S excessive-group',
    '2 0 malformed-observation',
  ])('rejects malformed or out-of-range rows: %s', (input) => {
    expect(() => parseProcessTable(input)).toThrow();
  });
  it('bounds the raw process-table boundary', () => {
    expect(() => parseProcessTable({ stdout: 'unvalidated' })).toThrow();
    expect(() => parseProcessTable(' '.repeat(4 * 1024 * 1024 + 1))).toThrow();
  });
});
it('imports raw supervisor and shared snapshot modules without built assets', () => {
  const supervisor = new URL('./local-supervisor.ts', import.meta.url).href;
  const snapshot = new URL('../../../shared/coding-runs.ts', import.meta.url)
    .href;
  // No IPC is sent: importing the supervisor cannot start a provider. Exit
  // explicitly after imports so its abandoned-start timer need not expire.
  const script = `await import(${JSON.stringify(supervisor)});await import(${JSON.stringify(snapshot)});console.log('native-source-imports-ok');process.exit(0);`;
  const output = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', script],
    {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 4096,
      env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
    },
  );
  expect(output.trim()).toBe('native-source-imports-ok');
});
