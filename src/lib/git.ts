import { spawn } from 'node:child_process';
import * as v from 'valibot';
import { ExecFileError } from './exec';

const schedulerGitTimeoutMs = 20_000;
const schedulerGitMaxBuffer = 4 * 1024 * 1024;
export const unattendedGitTimeoutMs = 30_000;
export const unattendedGitMaxBuffer = 10 * 1024 * 1024;

export type UnattendedGitOptions = {
  env?: NodeJS.ProcessEnv;
  gitExecutable?: string;
  timeoutMs?: number;
  maxBuffer?: number;
  signal?: AbortSignal;
};

export type GitRemoteProbe = {
  remote: string;
  ref: string;
  sha: string | null;
  reachable: true;
};

export type GitCredentialProbe = {
  protocol: 'https' | 'ssh' | 'local';
  provided: true;
  source:
    | 'credential-helper-or-askpass'
    | 'ssh-authenticated-remote'
    | 'local-transport';
  login: string | null;
  repositoryPush: boolean | null;
};

export type GitPushAccessProbe = {
  credential: GitCredentialProbe;
  remote: GitRemoteProbe;
};

export type GitPushAccessExpectation = {
  apiLogin: string | null;
  requireBoundIdentity: boolean;
};

export type GitPushAccessDecision = {
  ready: boolean;
  status: 'ready' | 'blocked' | 'warning';
  message: string;
};

const githubCredentialRepositorySchema = v.object({
  permissions: v.object({ push: v.boolean() }),
});
const githubCredentialUserSchema = v.object({
  login: v.pipe(v.string(), v.minLength(1)),
});

/** Build the environment shared by readiness probes and later unattended Git. */
export function unattendedGitEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const sshCommand =
    env.GIT_SSH_COMMAND ??
    (env.GIT_SSH ? shellQuoteExecutable(env.GIT_SSH) : 'ssh');
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    SSH_ASKPASS_REQUIRE: 'never',
    GIT_SSH_COMMAND: `${sshCommand} -oBatchMode=yes -oConnectTimeout=15`,
  };
}

export async function runUnattendedGit(
  cwd: string,
  args: string[],
  options: UnattendedGitOptions = {},
) {
  return runUnattendedGitWithInput(cwd, args, '', options);
}

export async function runUnattendedGitWithInput(
  cwd: string,
  args: string[],
  stdin: string,
  options: UnattendedGitOptions = {},
) {
  const timeoutMs = options.timeoutMs ?? unattendedGitTimeoutMs;
  const maxBuffer = options.maxBuffer ?? unattendedGitMaxBuffer;
  if (options.signal?.aborted) {
    throw redactGitError(
      new ExecFileError(`git ${args.join(' ')} was aborted.`, {
        signal: 'SIGTERM',
      }),
    );
  }
  return new Promise<string>((resolve, reject) => {
    const child = spawn(options.gitExecutable ?? 'git', args, {
      cwd,
      env: unattendedGitEnv(options.env),
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let terminationError: ExecFileError | undefined;
    let killTimeout: NodeJS.Timeout | undefined;
    const stdout = () => Buffer.concat(stdoutChunks, stdoutBytes).toString();
    const stderr = () => Buffer.concat(stderrChunks, stderrBytes).toString();
    const finish = (error?: ExecFileError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimeout) clearTimeout(killTimeout);
      options.signal?.removeEventListener('abort', abort);
      if (error) reject(redactGitError(error));
      else resolve(stdout());
    };
    const terminate = (error: ExecFileError) => {
      if (terminationError || settled) return;
      terminationError = error;
      terminateProcessGroup(child.pid, 'SIGTERM');
      killTimeout = setTimeout(() => {
        terminateProcessGroup(child.pid, 'SIGKILL');
        finish(error);
      }, 250);
    };
    const abort = () =>
      terminate(
        new ExecFileError(`git ${args.join(' ')} was aborted.`, {
          signal: 'SIGTERM',
          stdout: stdout(),
          stderr: stderr(),
        }),
      );
    const timeout = setTimeout(
      () =>
        terminate(
          new ExecFileError(
            `git ${args.join(' ')} timed out after ${timeoutMs}ms.`,
            {
              signal: 'SIGTERM',
              stdout: stdout(),
              stderr: stderr(),
              timedOut: true,
            },
          ),
        ),
      timeoutMs,
    );
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => {
      if (terminationError || settled) return;
      const allowed = Math.max(0, maxBuffer - stdoutBytes);
      if (allowed > 0) {
        const retained = chunk.subarray(0, allowed);
        stdoutChunks.push(retained);
        stdoutBytes += retained.length;
      }
      if (chunk.length > allowed) {
        terminate(
          new ExecFileError(
            `git ${args.join(' ')} exceeded its output limit.`,
            {
              signal: 'SIGTERM',
              stdout: stdout(),
              stderr: stderr(),
            },
          ),
        );
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (terminationError || settled) return;
      const allowed = Math.max(0, maxBuffer - stderrBytes);
      if (allowed > 0) {
        const retained = chunk.subarray(0, allowed);
        stderrChunks.push(retained);
        stderrBytes += retained.length;
      }
      if (chunk.length > allowed) {
        terminate(
          new ExecFileError(
            `git ${args.join(' ')} exceeded its output limit.`,
            {
              signal: 'SIGTERM',
              stdout: stdout(),
              stderr: stderr(),
            },
          ),
        );
      }
    });
    child.once('error', (error) => {
      if (terminationError) {
        terminateProcessGroup(child.pid, 'SIGKILL');
        finish(terminationError);
        return;
      }
      finish(
        new ExecFileError(error.message, {
          stdout: stdout(),
          stderr: stderr(),
          cause: error,
        }),
      );
    });
    child.once('close', (code, signal) => {
      if (terminationError) {
        terminateProcessGroup(child.pid, 'SIGKILL');
        finish(terminationError);
      } else if (code === 0) finish();
      else {
        const stderrOutput = stderr();
        finish(
          new ExecFileError(
            stderrOutput.trim() ||
              `git ${args.join(' ')} failed with code ${code}.`,
            {
              code,
              signal,
              stdout: stdout(),
              stderr: stderrOutput,
            },
          ),
        );
      }
    });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE') return;
      terminate(
        new ExecFileError(
          `git ${args.join(' ')} stdin failed: ${error.message}`,
          {
            stdout: stdout(),
            stderr: stderr(),
            cause: error,
          },
        ),
      );
    });
    child.stdin.end(stdin);
  });
}

export async function probeGitRemote(
  cwd: string,
  input: { remote: string; ref: string },
  options: UnattendedGitOptions & {
    runGit?: (cwd: string, args: string[]) => Promise<string>;
  } = {},
): Promise<GitRemoteProbe> {
  const runGit =
    options.runGit ?? ((path, args) => runUnattendedGit(path, args, options));
  const stdout = await runGit(cwd, [
    'ls-remote',
    '--refs',
    '--',
    input.remote,
    input.ref,
  ]);
  const sha = stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find(([, ref]) => ref === input.ref)?.[0];
  return {
    remote: redactGitText(input.remote),
    ref: input.ref,
    sha: sha && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha) ? sha : null,
    reachable: true,
  };
}

export async function probeGitPushAccess(
  cwd: string,
  input: { remote: string; ref: string },
  options: UnattendedGitOptions & {
    runGit?: (cwd: string, args: string[]) => Promise<string>;
    validateHttpsCredential?: (input: {
      remote: URL;
      username: string;
      password: string;
      timeoutMs: number;
      signal?: AbortSignal;
    }) => Promise<{ login: string; repositoryPush: true }>;
  } = {},
): Promise<GitPushAccessProbe> {
  const protocol = gitRemoteProtocol(input.remote);
  validateProbeRemote(input.remote, protocol);
  let credential: GitCredentialProbe;
  if (protocol === 'https') {
    const parsed = new URL(input.remote);
    const credentialOutput = await runUnattendedGitWithInput(
      cwd,
      ['credential', 'fill'],
      [
        'protocol=https',
        `host=${parsed.host}`,
        `path=${parsed.pathname.replace(/^\//, '').replace(/\.git$/, '')}`,
        '',
      ].join('\n'),
      options,
    );
    const fields = new Map<string, string>(
      credentialOutput
        .split(/\r?\n/)
        .map((line): [string, string] => {
          const separator = line.indexOf('=');
          return separator < 0
            ? ['', '']
            : [line.slice(0, separator), line.slice(separator + 1)];
        })
        .filter(([key, value]) => Boolean(key && value)),
    );
    if (!fields.get('username') || !fields.get('password')) {
      throw new Error(
        'Git credential lookup did not return both username and password/token.',
      );
    }
    const validation = await (
      options.validateHttpsCredential ?? validateGitHubCredential
    )({
      remote: parsed,
      username: fields.get('username')!,
      password: fields.get('password')!,
      timeoutMs: options.timeoutMs ?? unattendedGitTimeoutMs,
      signal: options.signal,
    });
    credential = {
      protocol: 'https',
      provided: true,
      source: 'credential-helper-or-askpass',
      login: validation.login,
      repositoryPush: validation.repositoryPush,
    };
  } else if (protocol === 'ssh') {
    credential = {
      protocol: 'ssh',
      provided: true,
      source: 'ssh-authenticated-remote',
      login: null,
      repositoryPush: null,
    };
  } else {
    credential = {
      protocol: 'local',
      provided: true,
      source: 'local-transport',
      login: null,
      repositoryPush: null,
    };
  }
  const remote = await probeGitRemote(cwd, input, options);
  return { credential, remote };
}

export function evaluateGitPushAccess(
  probe: GitPushAccessProbe,
  expectation: GitPushAccessExpectation,
): GitPushAccessDecision {
  if (!expectation.apiLogin) {
    return {
      ready: false,
      status: 'warning',
      message:
        'GitHub API actor is unavailable, so Git and API permission facts cannot be bound to one identity.',
    };
  }
  if (!probe.credential.login) {
    return {
      ready: !expectation.requireBoundIdentity,
      status: expectation.requireBoundIdentity ? 'warning' : 'ready',
      message:
        'Git transport authenticated, but its actor cannot be proven to match the GitHub API actor.',
    };
  }
  if (
    probe.credential.login.toLowerCase() !== expectation.apiLogin.toLowerCase()
  ) {
    return {
      ready: false,
      status: 'blocked',
      message: `Git uses ${probe.credential.login}, while the GitHub API uses ${expectation.apiLogin}.`,
    };
  }
  if (probe.credential.repositoryPush !== true) {
    return {
      ready: false,
      status: 'blocked',
      message:
        'The bound Git credential was not proven to have repository push permission.',
    };
  }
  return {
    ready: true,
    status: 'ready',
    message: `Git and GitHub API credentials are bound to ${probe.credential.login}.`,
  };
}

export function redactGitText(value: string) {
  return value
    .replace(
      /(^|\r?\n)((?:password|passwd|oauth[_-]?token|access[_-]?token|token|authorization|credential)=)[^\r\n]*/gi,
      '$1$2[redacted]',
    )
    .replace(/(authorization:\s*(?:basic|bearer)\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/\b([a-z][a-z\d+.-]*):\/\/[^/\s@]+@/gi, '$1://')
    .replace(
      /([?&](?:access[_-]?token|auth(?:orization)?|credential|oauth[_-]?token|passw(?:or)?d|token)=)[^&#\s]+/gi,
      '$1[redacted]',
    )
    .replace(/#\S*/g, '');
}

export async function runBoundedGit(cwd: string, args: string[]) {
  const stdout = await runUnattendedGit(cwd, args, {
    timeoutMs: schedulerGitTimeoutMs,
    maxBuffer: schedulerGitMaxBuffer,
  });
  return stdout.trim();
}

export async function runBoundedGitLines(cwd: string, args: string[]) {
  return (await runBoundedGit(cwd, args))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function redactGitError(error: unknown) {
  if (error instanceof ExecFileError) {
    return new ExecFileError(redactGitText(error.message), {
      code: error.code,
      signal: error.signal,
      stdout: redactGitText(error.stdout),
      stderr: redactGitText(error.stderr),
      timedOut: error.timedOut,
    });
  }
  return new Error(
    redactGitText(error instanceof Error ? error.message : String(error)),
  );
}

function shellQuoteExecutable(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function terminateProcessGroup(
  pid: number | undefined,
  signal: NodeJS.Signals,
) {
  if (!pid) return;
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, signal);
  } catch {
    // The process may already have exited.
  }
}

function validateProbeRemote(
  remote: string,
  protocol: 'https' | 'ssh' | 'local',
) {
  if (protocol === 'https' || /^ssh:\/\//i.test(remote)) {
    const parsed = new URL(remote);
    if (parsed.password || (protocol === 'https' && parsed.username)) {
      throw new Error('Git remote URLs must not contain embedded credentials.');
    }
    if (parsed.search || parsed.hash) {
      throw new Error('Git remote URLs must not contain a query or fragment.');
    }
    return;
  }
  if (protocol === 'ssh' && /[?#]/.test(remote)) {
    throw new Error('Git remote URLs must not contain a query or fragment.');
  }
}

async function validateGitHubCredential(input: {
  remote: URL;
  username: string;
  password: string;
  timeoutMs: number;
  signal?: AbortSignal;
}) {
  if (input.remote.hostname.toLowerCase() !== 'github.com') {
    throw new Error(
      'HTTPS credential validation currently supports github.com remotes only.',
    );
  }
  const [owner, repoWithSuffix, extra] = input.remote.pathname
    .replace(/^\//, '')
    .split('/');
  const repo = repoWithSuffix?.replace(/\.git$/, '');
  if (!owner || !repo || extra) {
    throw new Error('GitHub remote path is not an owner/repository pair.');
  }
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  input.signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.timeoutMs);
  try {
    const request = (url: string) =>
      fetch(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Basic ${Buffer.from(`${input.username}:${input.password}`).toString('base64')}`,
          'User-Agent': 'neondeck-autopilot-readiness',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: controller.signal,
      });
    const [repositoryResponse, userResponse] = await Promise.all([
      request(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      ),
      request('https://api.github.com/user'),
    ]);
    if (!repositoryResponse.ok || !userResponse.ok) {
      throw new Error(
        `Git credential was rejected by GitHub (HTTP ${repositoryResponse.ok ? userResponse.status : repositoryResponse.status}).`,
      );
    }
    const [rawRepository, rawUser] = await Promise.all([
      repositoryResponse.json(),
      userResponse.json(),
    ]);
    const repository = v.safeParse(
      githubCredentialRepositorySchema,
      rawRepository,
    );
    const user = v.safeParse(githubCredentialUserSchema, rawUser);
    if (!repository.success || !user.success) {
      throw new Error(
        'GitHub returned malformed repository or credential identity metadata.',
      );
    }
    if (repository.output.permissions.push !== true) {
      throw new Error(
        'Git credential is valid but does not have push permission for the target repository.',
      );
    }
    return { login: user.output.login, repositoryPush: true as const };
  } catch (error) {
    if (controller.signal.aborted) {
      if (!timedOut && input.signal?.aborted) {
        throw new Error('Git credential validation was aborted.');
      }
      throw new Error(
        `Git credential validation timed out after ${input.timeoutMs}ms.`,
      );
    }
    throw redactGitError(error);
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', abort);
    controller.abort();
  }
}

function gitRemoteProtocol(remote: string): 'https' | 'ssh' | 'local' {
  if (/^https:\/\//i.test(remote)) return 'https';
  if (/^ssh:\/\//i.test(remote) || /^(?:[^@\s]+@)?[^:\s]+:.+/.test(remote)) {
    return 'ssh';
  }
  if (/^(?:file:\/\/|\/|\.\.\/|\.\/)/.test(remote)) return 'local';
  throw new Error('Unsupported Git push remote transport.');
}
