// flue-blueprint: sandbox/exedev@1
/**
 * exe.dev adapter for Flue.
 *
 * Wraps an already-available exe.dev VM into Flue's SandboxFactory interface
 * using SSH for shell commands and SFTP for file operations.
 *
 * This adapter depends on Node.js APIs and the `ssh2` package, so use it
 * with Flue's Node target. It is not suitable for Cloudflare Worker-target
 * agents.
 *
 * Optional lifecycle helpers (`createExeVm`, `cloneExeVm`, `deleteExeVm`)
 * use exe.dev's HTTPS API before/after agent setup. The adapter itself
 * does not create, clone, or delete infrastructure.
 */
import {
  sandboxFromDriver,
  SandboxOperationUnsupportedError,
} from '@flue/runtime';
import type {
  FileStat,
  SandboxDriver,
  SandboxFactory,
  Sandbox,
} from '@flue/runtime';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client as SSHClient } from 'ssh2';
import type { ConnectConfig, SFTPWrapper } from 'ssh2';
import * as v from 'valibot';

export interface ExeDevVm {
  /** VM hostname, e.g. "maple-dune.exe.xyz". */
  host: string;
  /** VM name, used by lifecycle helpers for deletion. */
  name?: string;
  /** SSH port. Defaults to 22. */
  port?: number;
}

export interface ExeDevAdapterOptions {
  /** SSH username on the VM. Defaults to "user" (exeuntu default). */
  username?: string;
  /** SSH port. Defaults to the VM port, then 22. */
  port?: number;
  /** SSH private key as a raw PEM string or Buffer. */
  privateKey?: string | Buffer;
  /** Path to an SSH private key file. */
  privateKeyPath?: string;
  /** SSH agent socket path. Falls back to `$SSH_AUTH_SOCK` when no key resolves. */
  agent?: string;
  /** Maximum combined stdout/stderr bytes to retain before closing the stream. */
  maxOutputBytes?: number;
}

export type ResolvedSshAuth = {
  privateKey?: string | Buffer;
  agent?: string;
};

type SshAuthAttempt = { source: string; path: string; reason: string };

export interface ExeDevLifecycleOptions {
  /** exe.dev HTTPS API bearer token (exe0.* or exe1.*). */
  apiToken: string;
  /** Optional VM name for `new <name>`. Omit to let exe.dev generate one. */
  name?: string;
  /** How long to wait for SSH after create/clone. Defaults to 90000ms. */
  readyTimeoutMs?: number;
  /** SSH options used for the readiness check. */
  ssh?: ExeDevAdapterOptions;
}

export interface CloneExeVmOptions {
  /** exe.dev HTTPS API bearer token (exe0.* or exe1.*). */
  apiToken: string;
  /** Source VM name to clone with `cp <source>`. */
  source: string;
  /** How long to wait for SSH after clone. Defaults to 90000ms. */
  readyTimeoutMs?: number;
  /** SSH options used for the readiness check. */
  ssh?: ExeDevAdapterOptions;
}

export interface DeleteExeVmOptions {
  /** exe.dev HTTPS API bearer token (exe0.* or exe1.*). */
  apiToken: string;
  /** VM name to delete with `rm <name>`. */
  name: string;
}

export class ExeDevError extends Error {
  override name = 'ExeDevError';

  constructor(message: string) {
    super(message);
    Error.captureStackTrace?.(this, ExeDevError);
  }
}

const exeApiUrl = 'https://exe.dev/exec';
const defaultVmReadyTimeoutMs = 90_000;
const defaultMaxOutputBytes = 1024 * 1024;
const vmName = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const shellEnvName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const disposers = new WeakMap<Sandbox, () => void>();
const exeVmResponseSchema = v.looseObject({
  vm_name: v.optional(v.unknown()),
  name: v.optional(v.unknown()),
  vm: v.optional(v.unknown()),
  ssh_dest: v.optional(v.unknown()),
  ssh_port: v.optional(v.unknown()),
});
const sshErrorSchema = v.looseObject({
  code: v.optional(v.unknown()),
  errno: v.optional(v.unknown()),
  message: v.optional(v.unknown()),
});

async function exeApi(token: string, command: string): Promise<string> {
  const res = await fetch(exeApiUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'text/plain',
    },
    body: command,
  });
  const body = await res.text();
  if (!res.ok) {
    throw new ExeDevError(
      `exe.dev HTTPS API returned ${res.status}.\n` +
        `  Response: ${body.slice(0, 200)}\n` +
        "  Check that your apiToken is valid and that its 'cmds' include the command you're running.",
    );
  }
  return body;
}

export function parseVmResponse(output: string): ExeDevVm & { name: string } {
  let raw: ReturnType<typeof JSON.parse>;
  try {
    raw = JSON.parse(output);
  } catch {
    throw new ExeDevError(
      'exe.dev HTTPS API returned non-JSON output:\n' +
        `  ${output.slice(0, 200)}`,
    );
  }
  const parsed = v.safeParse(exeVmResponseSchema, raw);
  const data = parsed.success ? parsed.output : {};
  const vmName = v.safeParse(v.string(), data.vm_name);
  const fallbackName = v.safeParse(v.string(), data.name);
  const legacyName = v.safeParse(v.string(), data.vm);
  const name =
    (vmName.success ? vmName.output : undefined) ??
    (fallbackName.success ? fallbackName.output : undefined) ??
    (legacyName.success ? legacyName.output : undefined);
  if (!name) {
    throw new ExeDevError(
      'exe.dev HTTPS API response missing `vm_name`:\n' +
        `  ${JSON.stringify(data).slice(0, 200)}`,
    );
  }
  const parsedHost = v.safeParse(v.string(), data.ssh_dest);
  const host =
    (parsedHost.success ? parsedHost.output : '') || `${name}.exe.xyz`;
  const parsedPort = v.safeParse(v.number(), data.ssh_port);
  const port =
    parsedPort.success && Number.isFinite(parsedPort.output)
      ? parsedPort.output
      : undefined;
  return { name, host, port };
}

export async function createExeVm(
  options: ExeDevLifecycleOptions,
): Promise<ExeDevVm & { name: string }> {
  const cmd = options.name ? `new ${validateVmName(options.name)}` : 'new';
  const vm = parseVmResponse(await exeApi(options.apiToken, cmd));
  await waitForExeVm(vm, options.ssh, options.readyTimeoutMs);
  return vm;
}

export async function cloneExeVm(
  options: CloneExeVmOptions,
): Promise<ExeDevVm & { name: string }> {
  const vm = parseVmResponse(
    await exeApi(options.apiToken, `cp ${validateVmName(options.source)}`),
  );
  await waitForExeVm(vm, options.ssh, options.readyTimeoutMs);
  return vm;
}

export async function deleteExeVm(options: DeleteExeVmOptions): Promise<void> {
  await exeApi(options.apiToken, `rm ${validateVmName(options.name)}`);
}

export async function waitForExeVm(
  vm: ExeDevVm,
  options?: ExeDevAdapterOptions,
  timeoutMs = defaultVmReadyTimeoutMs,
): Promise<void> {
  if (timeoutMs <= 0) return;
  const { disconnect } = await sshConnectWithRetry(
    vm,
    options ?? {},
    timeoutMs,
  );
  disconnect();
}

function validateVmName(name: string): string {
  if (!vmName.test(name)) {
    throw new ExeDevError(`Invalid exe.dev VM name: ${name}`);
  }
  return name;
}

function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}

function shellEnvAssignment(name: string, value: string): string {
  if (!shellEnvName.test(name)) {
    throw new ExeDevError(`Invalid environment variable name: ${name}`);
  }
  return `${name}='${shellEscape(value)}'`;
}

export function resolveAuth(
  opts: ExeDevAdapterOptions,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSshAuth {
  if (opts.privateKey) return { privateKey: opts.privateKey };

  const tried: SshAuthAttempt[] = [];

  const tryPath = (
    keyPath: string,
    source: string,
  ): string | Buffer | undefined => {
    try {
      return fs.readFileSync(keyPath);
    } catch (err) {
      const parsed = v.safeParse(
        v.looseObject({ code: v.optional(v.string()) }),
        err,
      );
      const code = parsed.success ? (parsed.output.code ?? 'ERROR') : 'ERROR';
      tried.push({ source, path: keyPath, reason: code });
      return undefined;
    }
  };

  if (opts.privateKeyPath) {
    const key = tryPath(opts.privateKeyPath, 'privateKeyPath option');
    if (key) return { privateKey: key };
  }

  if (opts.agent) return { agent: opts.agent };

  const envPath = env.EXE_SSH_KEY;
  if (envPath) {
    const key = tryPath(envPath, '$EXE_SSH_KEY');
    if (key) return { privateKey: key };
  }

  const home = os.homedir();
  for (const name of ['id_ed25519', 'id_rsa']) {
    const keyPath = path.join(home, '.ssh', name);
    const key = tryPath(keyPath, 'default');
    if (key) return { privateKey: key };
  }

  if (env.SSH_AUTH_SOCK) return { agent: env.SSH_AUTH_SOCK };

  const triedLines =
    tried.length > 0
      ? tried
          .map((t) => `    - ${t.path} (${t.source}, ${t.reason})`)
          .join('\n')
      : '    (none)';

  throw new ExeDevError(
    "Couldn't find an SSH private key or running agent.\n" +
      `  Tried:\n${triedLines}\n` +
      '  Fix it by one of:\n' +
      "    - Pass `agent: '/path/to/agent.sock'` (or set $SSH_AUTH_SOCK)\n" +
      '    - Set EXE_SSH_KEY=/path/to/your/key\n' +
      '    - Pass `privateKeyPath` or `privateKey` to exedev()\n' +
      '    - Generate a default key: ssh-keygen -t ed25519',
  );
}

const retryableErrorCodes = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

export function isRetryableSshError<TError>(err: TError): boolean {
  const parsed = v.safeParse(sshErrorSchema, err);
  if (!parsed.success) return false;
  const e = parsed.output;
  const code = v.safeParse(v.string(), e.code);
  const errno = v.safeParse(v.string(), e.errno);
  const message = v.safeParse(v.string(), e.message);
  if (code.success && retryableErrorCodes.has(code.output)) {
    return true;
  }
  if (errno.success && retryableErrorCodes.has(errno.output)) {
    return true;
  }
  return (
    message.success &&
    /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)\b/.test(
      message.output,
    )
  );
}

async function sshConnectWithRetry(
  vm: ExeDevVm,
  opts: ExeDevAdapterOptions,
  timeoutMs: number,
): Promise<{ ssh: SSHClient; disconnect: () => void }> {
  const start = Date.now();
  let lastErr: unknown;
  while (true) {
    try {
      return await sshConnect(vm, opts);
    } catch (err) {
      lastErr = err;
      if (!isRetryableSshError(err)) throw err;
      if (Date.now() - start > timeoutMs) {
        const parsedLastError = v.safeParse(sshErrorSchema, lastErr);
        const parsedLastMessage = v.safeParse(
          v.string(),
          parsedLastError.success ? parsedLastError.output.message : undefined,
        );
        const lastMessage = parsedLastMessage.success
          ? parsedLastMessage.output
          : undefined;
        throw new ExeDevError(
          `Timed out after ${Math.round((Date.now() - start) / 1000)}s waiting ` +
            `for ${vm.host} to become SSH-able.\n` +
            `  Last error: ${lastMessage ?? String(lastErr)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function sshConnect(
  vm: ExeDevVm,
  opts: ExeDevAdapterOptions,
): Promise<{ ssh: SSHClient; disconnect: () => void }> {
  const ssh = new SSHClient();
  const config: ConnectConfig = {
    host: vm.host,
    port: opts.port ?? vm.port ?? 22,
    username: opts.username ?? 'user',
    ...resolveAuth(opts),
  };

  await new Promise<void>((resolve, reject) => {
    ssh.on('ready', resolve);
    ssh.on('error', reject);
    ssh.connect(config);
  });

  return {
    ssh,
    disconnect: () => ssh.end(),
  };
}

export interface SshLike {
  sftp(cb: (err: Error | undefined, sftp: SFTPWrapper) => void): void;
  exec(
    command: string,
    options: SshExecOptions,
    cb: (err: Error | undefined, stream: SshExecStream) => void,
  ): void;
}

export type SshExecOptions = Record<string, never>;

export interface SshExecStream {
  on(event: 'data', listener: (data: Buffer) => void): void;
  on(event: 'close', listener: (code: number) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  stderr: { on(event: 'data', listener: (data: Buffer) => void): void };
  close(): void;
}

export class ExeDevSandboxApi implements SandboxDriver {
  private sftpInstance: SFTPWrapper | null = null;
  private sftpPromise: Promise<SFTPWrapper> | null = null;

  constructor(
    private ssh: SshLike,
    private maxOutputBytes = defaultMaxOutputBytes,
  ) {}

  private getSftp(): Promise<SFTPWrapper> {
    if (this.sftpInstance) return Promise.resolve(this.sftpInstance);
    if (this.sftpPromise) return this.sftpPromise;
    this.sftpPromise = new Promise<SFTPWrapper>((resolve, reject) => {
      this.ssh.sftp((err, sftp) => {
        if (err) {
          this.sftpPromise = null;
          return reject(err);
        }
        const drop = () => {
          if (this.sftpInstance === sftp) this.sftpInstance = null;
          if (this.sftpPromise) this.sftpPromise = null;
        };
        sftp.once('close', drop);
        sftp.once('end', drop);
        sftp.on('error', drop);
        this.sftpInstance = sftp;
        resolve(sftp);
      });
    });
    return this.sftpPromise;
  }

  async readFile(filePath: string): Promise<string> {
    const sftp = await this.getSftp();
    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = sftp.createReadStream(filePath, { encoding: 'utf-8' });
      stream.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      stream.on('error', reject);
    });
  }

  async readFileBuffer(filePath: string): Promise<Uint8Array> {
    const sftp = await this.getSftp();
    return new Promise<Uint8Array>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = sftp.createReadStream(filePath);
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
      stream.on('error', reject);
    });
  }

  async writeFile(
    filePath: string,
    content: string | Uint8Array,
  ): Promise<void> {
    const buf = Buffer.from(content);
    const sftp = await this.getSftp();
    return new Promise<void>((resolve, reject) => {
      const stream = sftp.createWriteStream(filePath);
      stream.on('close', () => resolve());
      stream.on('error', reject);
      stream.end(buf);
    });
  }

  async stat(filePath: string): Promise<FileStat> {
    const sftp = await this.getSftp();
    return new Promise<FileStat>((resolve, reject) => {
      sftp.stat(filePath, (err, stats) => {
        if (err) return reject(err);
        resolve({
          isFile: stats.isFile(),
          isDirectory: stats.isDirectory(),
          isSymbolicLink: stats.isSymbolicLink(),
          size: stats.size,
          mtime: new Date(stats.mtime * 1000),
        });
      });
    });
  }

  async readdir(dirPath: string): Promise<string[]> {
    const sftp = await this.getSftp();
    return new Promise<string[]>((resolve, reject) => {
      sftp.readdir(dirPath, (err, list) => {
        if (err) return reject(err);
        resolve(list.map((entry) => entry.filename));
      });
    });
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await this.stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(
    dirPath: string,
    options?: { recursive?: boolean },
  ): Promise<void> {
    if (options?.recursive) {
      await this.exec(`mkdir -p '${shellEscape(dirPath)}'`);
      return;
    }
    const sftp = await this.getSftp();
    return new Promise<void>((resolve, reject) => {
      sftp.mkdir(dirPath, (err) => (err ? reject(err) : resolve()));
    });
  }

  async rm(
    filePath: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void> {
    const unsupported = [
      options?.recursive ? 'recursive' : undefined,
      options?.force ? 'force' : undefined,
    ].filter((option): option is string => option !== undefined);
    if (unsupported.length > 0) {
      throw new SandboxOperationUnsupportedError({
        operation: 'rm',
        provider: 'exe.dev',
        options: unsupported,
      });
    }
    const sftp = await this.getSftp();
    return new Promise<void>((resolve, reject) => {
      sftp.unlink(filePath, (unlinkErr) => {
        if (!unlinkErr) return resolve();
        sftp.rmdir(filePath, (rmdirErr) =>
          rmdirErr ? reject(rmdirErr) : resolve(),
        );
      });
    });
  }

  async exec(
    command: string,
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    let cmd = command;

    if (options?.env && Object.keys(options.env).length > 0) {
      const envPrefix = Object.entries(options.env)
        .map(([key, value]) => `export ${shellEnvAssignment(key, value)}`)
        .join('; ');
      cmd = `${envPrefix}; ${cmd}`;
    }
    if (options?.cwd) {
      cmd = `cd '${shellEscape(options.cwd)}' && ${cmd}`;
    }

    return new Promise((resolve, reject) => {
      this.ssh.exec(cmd, {}, (err, stream) => {
        if (err) return reject(err);

        let stdout = '';
        let stderr = '';
        let outputBytes = 0;
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const finish = (result: {
          stdout: string;
          stderr: string;
          exitCode: number;
        }) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve(result);
        };
        const append = (target: 'stdout' | 'stderr', data: Buffer) => {
          if (settled) return;
          const remaining = this.maxOutputBytes - outputBytes;
          if (remaining > 0) {
            const chunk =
              data.byteLength > remaining ? data.subarray(0, remaining) : data;
            if (target === 'stdout') {
              stdout += chunk.toString();
            } else {
              stderr += chunk.toString();
            }
            outputBytes += chunk.byteLength;
          }
          if (
            data.byteLength > remaining ||
            outputBytes >= this.maxOutputBytes
          ) {
            finish({
              stdout,
              stderr: `${stderr}\n[flue:exedev] Output exceeded ${this.maxOutputBytes} bytes and was truncated.`,
              exitCode: 124,
            });
            stream.close();
          }
        };
        const abort = () => {
          finish({
            stdout,
            stderr: `${stderr}\n[flue:exedev] Command aborted.`,
            exitCode: 124,
          });
          stream.close();
        };

        if (options?.signal?.aborted) {
          abort();
          return;
        }
        options?.signal?.addEventListener('abort', abort, { once: true });

        if (options?.timeoutMs !== undefined) {
          timer = setTimeout(() => {
            stream.close();
            finish({
              stdout,
              stderr: `${stderr}\n[flue:exedev] Command timed out after ${options.timeoutMs} milliseconds.`,
              exitCode: 124,
            });
          }, options.timeoutMs);
        }

        stream.on('data', (data: Buffer) => {
          append('stdout', data);
        });
        stream.stderr.on('data', (data: Buffer) => {
          append('stderr', data);
        });
        stream.on('close', (code: number) => {
          finish({ stdout, stderr, exitCode: code ?? 0 });
        });
        stream.on('error', (streamErr: Error) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          reject(streamErr);
        });
      });
    });
  }
}

export function exedev(
  vm: ExeDevVm | string,
  options?: ExeDevAdapterOptions,
): SandboxFactory {
  const resolvedVm = v.is(v.string(), vm) ? { host: vm } : vm;
  return {
    async createSandbox(_options): Promise<Sandbox> {
      const { env } = await createExeDevSessionEnv(resolvedVm, options);
      return env;
    },
  };
}

export async function createExeDevSessionEnv(
  vm: ExeDevVm | string,
  options?: ExeDevAdapterOptions,
): Promise<{ env: Sandbox; dispose: () => void }> {
  const resolvedVm = v.is(v.string(), vm) ? { host: vm } : vm;
  const { ssh, disconnect } = await sshConnect(resolvedVm, options ?? {});
  const api = new ExeDevSandboxApi(
    ssh,
    options?.maxOutputBytes ?? defaultMaxOutputBytes,
  );

  let sandboxCwd = '/home/user';
  try {
    const { stdout } = await api.exec('echo $HOME');
    const detected = stdout.trim();
    if (detected) sandboxCwd = detected;
  } catch {
    // Fall back to /home/user.
  }

  const env = sandboxFromDriver(api, sandboxCwd);
  disposers.set(env, disconnect);
  return { env, dispose: disconnect };
}

export function disposeExeDevSessionEnv(env: Sandbox): void {
  const dispose = disposers.get(env);
  if (!dispose) return;
  disposers.delete(env);
  dispose();
}
