import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import * as v from 'valibot';
import { privateDirectory } from '../coding-runs';
import { splitCommand, hasShellOperator } from '../execution';

const natural = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
export const candidateCheckInputSchema = v.strictObject({
  command: v.pipe(v.string(), v.minLength(1), v.maxLength(2000)),
  cwd: v.pipe(v.string(), v.minLength(1)),
  timeoutMs: v.pipe(natural, v.minValue(1), v.maxValue(600000)),
  maxOutputBytes: v.pipe(natural, v.minValue(1), v.maxValue(1048576)),
});
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const candidateCheckEnvironmentSchema = v.strictObject({
  policy: v.literal('private-check-env-v1'),
  fingerprint: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  nodeVersion: v.pipe(v.string(), v.maxLength(64)),
  platform: v.pipe(v.string(), v.maxLength(32)),
  architecture: v.pipe(v.string(), v.maxLength(32)),
  executableName: v.pipe(v.string(), v.maxLength(128)),
});
export const candidateCheckResultSchema = v.strictObject({
  exitCode: v.nullable(v.pipe(v.number(), v.safeInteger())),
  truncated: v.boolean(),
  durationMs: natural,
  noWriter: v.boolean(),
  timedOut: v.boolean(),
  cancelled: v.boolean(),
  stdout: v.pipe(v.string(), v.maxLength(1048576)),
  stderr: v.pipe(v.string(), v.maxLength(1048576)),
  environment: v.optional(candidateCheckEnvironmentSchema),
});
export type CandidateCheckResult = v.InferOutput<
  typeof candidateCheckResultSchema
>;

/** Dedicated test-data defaults, not a filesystem sandbox against same-UID code.
 * Never inherit operator config pointers, credentials, shell startup or PATH. */
export async function prepareCandidateCheckEnvironment(input?: string) {
  const directory =
    input === undefined
      ? await realpath(await mkdtemp(join(tmpdir(), 'neondeck-check-')))
      : v.parse(v.pipe(v.string(), v.minLength(1), v.check(isAbsolute)), input);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await privateDirectory(directory);
  const root = await realpath(directory);
  const paths = Object.fromEntries(
    ['home', 'config', 'data', 'cache', 'state', 'run', 'tmp', 'neondeck'].map(
      (name) => [name, join(root, name)],
    ),
  );
  for (const path of Object.values(paths)) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await privateDirectory(path);
  }
  const env = v.parse(v.record(v.string(), v.string()), {
    PATH: [
      ...new Set([
        dirname(process.execPath),
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
      ]),
    ].join(':'),
    HOME: paths.home,
    XDG_CONFIG_HOME: paths.config,
    XDG_DATA_HOME: paths.data,
    XDG_CACHE_HOME: paths.cache,
    XDG_STATE_HOME: paths.state,
    XDG_RUNTIME_DIR: paths.run,
    TMPDIR: paths.tmp,
    TMP: paths.tmp,
    TEMP: paths.tmp,
    NEONDECK_HOME: paths.neondeck,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TERM: 'dumb',
    CI: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/usr/bin/false',
    SSH_ASKPASS: '/usr/bin/false',
    GIT_SSH_COMMAND: '/usr/bin/false',
    GCM_INTERACTIVE: 'Never',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.interactive',
    GIT_CONFIG_VALUE_1: 'false',
    NPM_CONFIG_USERCONFIG: join(paths.config, 'npmrc'),
    NPM_CONFIG_GLOBALCONFIG: '/dev/null',
    NPM_CONFIG_CACHE: join(paths.cache, 'npm'),
  });
  return { directory: root, env };
}

async function resolveCheckExecutable(file: string, cwd: string, path: string) {
  const candidates =
    isAbsolute(file) || file.includes('/')
      ? [resolve(cwd, file)]
      : path.split(':').map((directory) => join(directory, file));
  for (const candidate of candidates) {
    try {
      const resolved = await realpath(candidate);
      await access(resolved, constants.X_OK);
      const metadata = await stat(resolved);
      if (metadata.isFile())
        return {
          resolved,
          metadata: {
            size: metadata.size,
            mtimeMs: metadata.mtimeMs,
            mode: metadata.mode,
          },
        };
    } catch {
      /* Try the next explicit toolchain directory. */
    }
  }
  throw new Error(
    'Configured verification executable is unavailable in the check toolchain',
  );
}

function groupAlive(pid: number) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      'code' in error &&
      error.code === 'ESRCH'
    );
  }
}
function killGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
      throw error;
  }
}
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runCandidateCheck(
  input: v.InferOutput<typeof candidateCheckInputSchema>,
  options: { signal?: AbortSignal; jobDirectory?: string } = {},
): Promise<CandidateCheckResult> {
  input = v.parse(candidateCheckInputSchema, input);
  const parsed = splitCommand(input.command);
  if (!parsed.ok || hasShellOperator(input.command))
    throw new Error(
      'Verification requires one configured command without shell operators',
    );
  if (options.signal?.aborted)
    return v.parse(candidateCheckResultSchema, {
      exitCode: null,
      truncated: false,
      timedOut: false,
      cancelled: true,
      noWriter: true,
      durationMs: 0,
      stdout: '',
      stderr: '',
    });
  const environment = await prepareCandidateCheckEnvironment(
    options.jobDirectory,
  );
  const executable = await resolveCheckExecutable(
    parsed.file,
    input.cwd,
    environment.env.PATH,
  );
  const normalizedEnvironment = Object.fromEntries(
    Object.entries(environment.env)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [
        key,
        value.replaceAll(environment.directory, '<private-job>'),
      ]),
  );
  const environmentManifest = v.parse(candidateCheckEnvironmentSchema, {
    policy: 'private-check-env-v1',
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    executableName: basename(executable.resolved).slice(0, 128),
    fingerprint: digest({
      policy: 'private-check-env-v1',
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      runtimeExecutable: process.execPath,
      executable,
      argv: parsed.args,
      environment: normalizedEnvironment,
    }),
  });
  const started = Date.now();
  let bytes = 0,
    truncated = false,
    timedOut = false,
    deathUncertain = false;
  const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  const child = spawn(executable.resolved, parsed.args, {
    cwd: input.cwd,
    env: environment.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pid = child.pid;
  let stopped = false,
    exited = false,
    closed = false,
    outputError = false;
  let exitCode: number | null = null;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (pid) {
      try {
        killGroup(pid, 'SIGKILL');
      } catch {
        deathUncertain = true;
        child.kill('SIGKILL');
      }
    }
  };
  const consume = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
    const remaining = Math.max(0, input.maxOutputBytes - bytes);
    if (remaining) output[stream].push(chunk.subarray(0, remaining));
    bytes += chunk.length;
    if (bytes > input.maxOutputBytes) {
      truncated = true;
      stop();
    }
  };
  child.stdout.on('data', (chunk: Buffer) => consume('stdout', chunk));
  child.stderr.on('data', (chunk: Buffer) => consume('stderr', chunk));
  child.stdout.on('error', () => {
    outputError = true;
    stop();
  });
  child.stderr.on('error', () => {
    outputError = true;
    stop();
  });
  child.once('exit', (code) => {
    exitCode = code;
    exited = true;
    stop();
  });
  child.once('error', () => {
    exitCode = null;
    exited = true;
    stop();
  });
  child.once('close', () => {
    closed = true;
  });
  const abort = () => stop();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) stop();
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, input.timeoutMs);
  let noWriter = false;
  try {
    // A failed kill must not leave collection waiting forever for leader exit.
    const exitDeadline = started + input.timeoutMs + 2000;
    while (!exited && Date.now() < exitDeadline) await pause(10);
    clearTimeout(timer);
    stop(); // Leader exit is not descendant death; terminate its remaining group.
    const drainDeadline = Date.now() + 2000;
    while (Date.now() < drainDeadline) {
      noWriter = exited && !deathUncertain && (!pid || !groupAlive(pid));
      if (
        noWriter &&
        closed &&
        child.stdout.readableEnded &&
        child.stderr.readableEnded
      )
        break;
      await pause(10);
    }
    noWriter = exited && !deathUncertain && (!pid || !groupAlive(pid));
    const complete =
      closed &&
      child.stdout.readableEnded &&
      child.stderr.readableEnded &&
      !outputError;
    if (!complete) {
      if (!child.stdout.readableEnded || !child.stderr.readableEnded)
        noWriter = false;
      truncated = true;
      exitCode = null;
    }
    return v.parse(candidateCheckResultSchema, {
      exitCode,
      truncated,
      timedOut,
      cancelled: options.signal?.aborted === true,
      noWriter,
      durationMs: Date.now() - started,
      environment: environmentManifest,
      stdout: Buffer.concat(output.stdout).toString('utf8'),
      stderr: Buffer.concat(output.stderr).toString('utf8'),
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    stop();
    // Only dispose streams after the bounded drain has established completeness
    // or explicitly made the result nonpassing. Never silently discard a tail.
    child.stdout.destroy();
    child.stderr.destroy();
    if (options.jobDirectory === undefined && noWriter)
      await rm(environment.directory, { recursive: true, force: true });
  }
}
