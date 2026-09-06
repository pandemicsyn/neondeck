import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as v from 'valibot';
import { identitySchema, type ProcessIdentity } from './host-contract.ts';
const exec = promisify(execFile);
export function localHostCapability() {
  return {
    supported: process.platform === 'linux' || process.platform === 'darwin',
    platform: process.platform,
    isolation: 'trusted-local-process-group',
  };
}
export async function processTable() {
  if (!localHostCapability().supported)
    throw new Error('Unsupported local host platform');
  const { stdout } = await exec(
    '/bin/ps',
    ['-axo', 'pid=,pgid=,lstart=,stat=,command='],
    {
      timeout: 3000,
      maxBuffer: 4 * 1024 * 1024,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    },
  );
  return stdout
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const match =
        /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(\S+)\s+(.*)$/.exec(
          line,
        );
      if (!match) throw new Error('Unrecognized process observation');
      return {
        ...v.parse(identitySchema, {
          pid: Number(match[1]),
          pgid: Number(match[2]),
          start: match[3],
          command: match[5],
        }),
        zombie: match[4].startsWith('Z'),
      };
    });
}
export async function identify(
  pid: number,
  nonce: string,
): Promise<ProcessIdentity> {
  const entry = (await processTable()).find(
    (row) => row.pid === pid && !row.zombie,
  );
  if (!entry || !entry.command.split(/\s+/).includes(nonce))
    throw new Error('Process ownership could not be authenticated');
  return v.parse(identitySchema, {
    pid: entry.pid,
    pgid: entry.pgid,
    start: entry.start,
    command: entry.command,
  });
}
export function sameProcess(
  expected: ProcessIdentity,
  observed: ProcessIdentity,
) {
  return (
    expected.pid === observed.pid &&
    expected.pgid === observed.pgid &&
    expected.start === observed.start &&
    expected.command === observed.command
  );
}
export async function groupAbsent(identity: ProcessIdentity) {
  return !(await processTable()).some(
    (row) => row.pgid === identity.pgid && !row.zombie,
  );
}
export async function signalOwnedGroup(
  identity: ProcessIdentity,
  signal: NodeJS.Signals,
) {
  const rows = await processTable();
  const leader = rows.find((row) => row.pid === identity.pid && !row.zombie);
  if (
    !leader ||
    !sameProcess(identity, leader) ||
    identity.pid !== identity.pgid
  )
    throw new Error('Process group ownership lost; refusing signal');
  process.kill(-identity.pgid, signal);
}
