import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

type LeaseOwner = {
  pid: number;
  processStart: string;
  token: string;
};

/**
 * Store a process generation as well as its PID. A recycled PID must never
 * keep a dead lock alive forever or make a prior holder look current.
 */
export async function createLeaseOwnerRecord(token: string) {
  return JSON.stringify({
    pid: process.pid,
    // `ps` is unavailable in some restricted runtimes (including the unit
    // test sandbox). Those records retain the PID liveness hint but are not
    // misrepresented as a verified process generation.
    processStart:
      (await processStartIdentity(process.pid).catch(() => null)) ??
      `unverified:${token}`,
    token,
  } satisfies LeaseOwner);
}

export async function leaseOwnerIsAlive(record: string | null) {
  const owner = parseLeaseOwner(record);
  if (!owner) return false;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return errorCode(error) !== 'ESRCH';
  }
  if (owner.processStart.startsWith('unverified:')) return true;
  return (
    (await processStartIdentity(owner.pid).catch(() => null)) ===
    owner.processStart
  );
}

function parseLeaseOwner(value: string | null): LeaseOwner | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<LeaseOwner>;
    return typeof parsed.pid === 'number' &&
      Number.isSafeInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.processStart === 'string' &&
      typeof parsed.token === 'string'
      ? (parsed as LeaseOwner)
      : null;
  } catch {
    // Records from the earlier PID-only format are safely recoverable once
    // stale, but cannot prove that an owner remains alive.
    return null;
  }
}

async function processStartIdentity(pid: number) {
  if (process.platform === 'linux') {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat
      .slice(stat.lastIndexOf(')') + 1)
      .trim()
      .split(/\s+/);
    const startTicks = fields[19];
    if (!startTicks)
      throw new Error(`Could not read process start for ${pid}.`);
    return `linux:${startTicks}`;
  }
  const { stdout } = await execFileAsync('ps', [
    '-p',
    String(pid),
    '-o',
    'lstart=',
  ]);
  const start = stdout.trim();
  if (!start) throw new Error(`Could not read process start for ${pid}.`);
  return `${process.platform}:${start}`;
}

function errorCode(error: unknown) {
  return error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
}
