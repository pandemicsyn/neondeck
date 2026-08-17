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
import { SandboxOperationUnsupportedError } from '@flue/runtime';
import type {
  FileStat,
  Sandbox,
  SandboxDriver,
  SandboxFactory,
  ShellResult,
} from '@flue/runtime';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client as SSHClient } from 'ssh2';
import type { ConnectConfig, SFTPWrapper, Stats } from 'ssh2';

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
  /** Whether the adapter may discover default keys or SSH_AUTH_SOCK. Defaults to true. */
  allowAmbientAuth?: boolean;
  /** Maximum combined stdout/stderr bytes to retain before closing the stream. */
  maxOutputBytes?: number;
  /** Infrastructure deadline for structured SSH/SFTP operations. */
  operationTimeoutMs?: number;
  /** Maximum bytes accepted by one structured file write. */
  maxWriteBytes?: number;
  /** Maximum bytes returned by one structured file or directory read. */
  maxReadBytes?: number;
}

/** Provider-neutral SSH transport options compatible with the original exe.dev adapter. */
export type SshAdapterOptions = ExeDevAdapterOptions;
export type SshHost = ExeDevVm;

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
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, ExeDevError);
    }
  }
}

const exeApiUrl = 'https://exe.dev/exec';
const defaultVmReadyTimeoutMs = 90_000;
const defaultMaxOutputBytes = 1024 * 1024;
const defaultOperationTimeoutMs = 60_000;
const defaultMaxWriteBytes = 16 * 1024 * 1024;
const defaultMaxReadBytes = 16 * 1024 * 1024;
const vmName = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const shellEnvName = /^[A-Za-z_][A-Za-z0-9_]*$/;
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
  let data: {
    vm_name?: unknown;
    name?: unknown;
    vm?: unknown;
    ssh_dest?: unknown;
    ssh_port?: unknown;
  };
  try {
    data = JSON.parse(output);
  } catch {
    throw new ExeDevError(
      'exe.dev HTTPS API returned non-JSON output:\n' +
        `  ${output.slice(0, 200)}`,
    );
  }
  const name =
    typeof data.vm_name === 'string'
      ? data.vm_name
      : typeof data.name === 'string'
        ? data.name
        : typeof data.vm === 'string'
          ? data.vm
          : undefined;
  if (!name) {
    throw new ExeDevError(
      'exe.dev HTTPS API response missing `vm_name`:\n' +
        `  ${JSON.stringify(data).slice(0, 200)}`,
    );
  }
  const host =
    typeof data.ssh_dest === 'string' && data.ssh_dest
      ? data.ssh_dest
      : `${name}.exe.xyz`;
  const port =
    typeof data.ssh_port === 'number' && Number.isFinite(data.ssh_port)
      ? data.ssh_port
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
  try {
    await exeApi(options.apiToken, `rm ${validateVmName(options.name)}`);
  } catch (error) {
    if (
      error instanceof ExeDevError &&
      /(?:not found|does not exist|no such (?:vm|machine))/i.test(error.message)
    ) {
      return;
    }
    throw error;
  }
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
): { privateKey?: string | Buffer; agent?: string } {
  if (opts.privateKey) return { privateKey: opts.privateKey };

  const tried: { source: string; path: string; reason: string }[] = [];

  const readPath = (keyPath: string, source: string): string | Buffer => {
    try {
      return fs.readFileSync(keyPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'ERROR';
      tried.push({ source, path: keyPath, reason: code });
      throw new ExeDevError(
        `SSH private key configured by ${source} is not readable: ${keyPath} (${code}).`,
      );
    }
  };

  if (opts.privateKeyPath) {
    return {
      privateKey: readPath(opts.privateKeyPath, 'privateKeyPath option'),
    };
  }

  const envPath = env.EXE_SSH_KEY;
  if (envPath) {
    return { privateKey: readPath(envPath, '$EXE_SSH_KEY') };
  }

  if (opts.allowAmbientAuth === false) {
    throw new ExeDevError(
      'SSH authentication requires an explicitly configured readable private key; ambient keys and SSH agents are disabled.',
    );
  }

  if (opts.agent) return { agent: opts.agent };

  const home = os.homedir();
  for (const name of ['id_ed25519', 'id_rsa']) {
    const keyPath = path.join(home, '.ssh', name);
    try {
      return { privateKey: fs.readFileSync(keyPath) };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'ERROR';
      tried.push({ source: 'default', path: keyPath, reason: code });
    }
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

export function isRetryableSshError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; errno?: unknown; message?: unknown };
  if (typeof e.code === 'string' && retryableErrorCodes.has(e.code)) {
    return true;
  }
  if (typeof e.errno === 'string' && retryableErrorCodes.has(e.errno)) {
    return true;
  }
  return (
    typeof e.message === 'string' &&
    /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)\b/.test(
      e.message,
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
        throw new ExeDevError(
          `Timed out after ${Math.round((Date.now() - start) / 1000)}s waiting ` +
            `for ${vm.host} to become SSH-able.\n` +
            `  Last error: ${(lastErr as Error)?.message ?? String(lastErr)}`,
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
  sftp(cb: (err: Error | undefined, sftp: SFTPWrapper) => void): unknown;
  exec(
    command: string,
    options: object,
    cb: (err: Error | undefined, stream: SshExecStream) => void,
  ): unknown;
}

export interface SshExecStream {
  on(event: 'data', listener: (data: Buffer) => void): unknown;
  on(
    event: 'close',
    listener: (code: number | undefined, signal?: string) => void,
  ): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  stderr: { on(event: 'data', listener: (data: Buffer) => void): unknown };
  close(): void;
}

export type SshCommandUncertainty = {
  kind: 'abort' | 'timeout' | 'output-limit' | 'transport';
  message: string;
};

export type SshOperationUncertainty = {
  kind: 'abort' | 'timeout' | 'transport';
  operation: 'writeFile' | 'mkdir' | 'rm';
  message: string;
};

export class SshOperationUncertainError extends ExeDevError {
  override name = 'SshOperationUncertainError';

  constructor(readonly uncertainty: SshOperationUncertainty) {
    super(uncertainty.message);
  }
}

export function isSshOperationUncertainError(
  error: unknown,
): error is SshOperationUncertainError {
  return error instanceof SshOperationUncertainError;
}

export type SshShellResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  uncertainty?: SshCommandUncertainty;
};

export function sshCommandUncertainty(
  result: { exitCode: number } | SshShellResult,
): SshCommandUncertainty | undefined {
  return 'uncertainty' in result ? result.uncertainty : undefined;
}

export class SshSandboxDriver implements SandboxDriver {
  private sftpInstance: SFTPWrapper | null = null;
  private sftpPromise: Promise<SFTPWrapper> | null = null;

  constructor(
    private ssh: SshLike,
    private maxOutputBytes = defaultMaxOutputBytes,
    private operationTimeoutMs = defaultOperationTimeoutMs,
    private maxWriteBytes = defaultMaxWriteBytes,
    private maxReadBytes = defaultMaxReadBytes,
  ) {}

  private resetSftpChannel() {
    try {
      this.sftpInstance?.end();
    } catch {
      // The operation deadline remains authoritative.
    }
    this.sftpInstance = null;
    this.sftpPromise = null;
  }

  private readonlyOperation<T>(
    operation: string,
    start: (onTimeout: (cleanup: () => void) => void) => Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let cleanup: (() => void) | undefined;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        cleanup?.();
        this.resetSftpChannel();
        finish(() =>
          reject(
            new ExeDevError(
              `[flue:ssh] Structured ${operation} timed out after ${this.operationTimeoutMs} milliseconds.`,
            ),
          ),
        );
      }, this.operationTimeoutMs);
      void start((next) => {
        cleanup = next;
      }).then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
    });
  }

  private uncertainMutation<T>(
    operation: SshOperationUncertainty['operation'],
    start: () => Promise<T>,
    options: { preserveMissingParent?: boolean } = {},
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        const message = `[flue:ssh] Structured ${operation} timed out after ${this.operationTimeoutMs} milliseconds; its remote effect was not confirmed settled.`;
        this.resetSftpChannel();
        finish(() =>
          reject(
            new SshOperationUncertainError({
              kind: 'timeout',
              operation,
              message,
            }),
          ),
        );
      }, this.operationTimeoutMs);
      void start().then(
        (value) => finish(() => resolve(value)),
        (error) => {
          if (options.preserveMissingParent && isMissingParentError(error)) {
            finish(() => reject(error));
            return;
          }
          const message = `[flue:ssh] Structured ${operation} transport failed after launch; its remote effect was not confirmed settled: ${error instanceof Error ? error.message : String(error)}`;
          finish(() =>
            reject(
              new SshOperationUncertainError({
                kind: 'transport',
                operation,
                message,
              }),
            ),
          );
        },
      );
    });
  }

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
    const value = await this.readFileBuffer(filePath);
    return Buffer.from(value).toString('utf-8');
  }

  async readFileBuffer(filePath: string): Promise<Uint8Array> {
    return this.readonlyOperation('readFile', async (onTimeout) => {
      const sftp = await this.getSftp();
      return new Promise<Uint8Array>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const stream = sftp.createReadStream(filePath);
        let settled = false;
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          callback();
        };
        onTimeout(() => {
          settled = true;
          stream.destroy();
        });
        stream.on('data', (chunk: Buffer) => {
          if (settled) return;
          size += chunk.byteLength;
          if (size > this.maxReadBytes) {
            const error = new ExeDevError(
              `SSH structured read exceeds the ${this.maxReadBytes}-byte limit.`,
            );
            finish(() => reject(error));
            stream.destroy();
            return;
          }
          chunks.push(chunk);
        });
        stream.on('end', () =>
          finish(() => resolve(new Uint8Array(Buffer.concat(chunks, size)))),
        );
        stream.on('error', (error: Error) => finish(() => reject(error)));
      });
    });
  }

  async writeFile(
    filePath: string,
    content: string | Uint8Array,
  ): Promise<void> {
    const buf =
      typeof content === 'string'
        ? Buffer.from(content, 'utf-8')
        : Buffer.from(content);
    if (buf.byteLength > this.maxWriteBytes) {
      throw new ExeDevError(
        `SSH structured write exceeds the ${this.maxWriteBytes}-byte limit.`,
      );
    }
    return this.uncertainMutation(
      'writeFile',
      async () => {
        const sftp = await this.getSftp();
        return new Promise<void>((resolve, reject) => {
          const stream = sftp.createWriteStream(filePath);
          stream.on('close', () => resolve());
          stream.on('error', reject);
          stream.end(buf);
        });
      },
      { preserveMissingParent: true },
    );
  }

  async stat(filePath: string): Promise<FileStat> {
    const [pathStats, targetStats] = await this.readonlyOperation(
      'stat',
      async () => {
        const sftp = await this.getSftp();
        return Promise.all([
          new Promise<Stats>((resolve, reject) => {
            sftp.lstat(filePath, (err, stats) =>
              err ? reject(err) : resolve(stats),
            );
          }),
          new Promise<Stats>((resolve, reject) => {
            sftp.stat(filePath, (err, stats) =>
              err ? reject(err) : resolve(stats),
            );
          }),
        ]);
      },
    );
    return {
      isFile: targetStats.isFile(),
      isDirectory: targetStats.isDirectory(),
      isSymbolicLink: pathStats.isSymbolicLink(),
      size: targetStats.size,
      mtime: new Date(targetStats.mtime * 1000),
    };
  }

  async readdir(dirPath: string): Promise<string[]> {
    return this.readonlyOperation('readdir', async () => {
      const sftp = await this.getSftp();
      return new Promise<string[]>((resolve, reject) => {
        sftp.readdir(dirPath, (err, list) => {
          if (err) return reject(err);
          const names = list.map((entry) => entry.filename);
          const size = names.reduce(
            (total, name) => total + Buffer.byteLength(name, 'utf8') + 1,
            0,
          );
          if (size > this.maxReadBytes) {
            reject(
              new ExeDevError(
                `SSH structured directory read exceeds the ${this.maxReadBytes}-byte limit.`,
              ),
            );
            return;
          }
          resolve(names);
        });
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
      const result = await this.exec(`mkdir -p '${shellEscape(dirPath)}'`, {
        timeoutMs: this.operationTimeoutMs,
      });
      const uncertainty = sshCommandUncertainty(result);
      if (uncertainty) {
        throw new SshOperationUncertainError({
          kind:
            uncertainty.kind === 'output-limit'
              ? 'transport'
              : uncertainty.kind,
          operation: 'mkdir',
          message: uncertainty.message,
        });
      }
      if (result.exitCode !== 0) {
        throw new Error(
          `SSH recursive directory creation failed for "${dirPath}": ${result.stderr.trim() || `exit ${result.exitCode}`}.`,
        );
      }
      return;
    }
    return this.uncertainMutation('mkdir', async () => {
      const sftp = await this.getSftp();
      return new Promise<void>((resolve, reject) => {
        sftp.mkdir(dirPath, (err) => (err ? reject(err) : resolve()));
      });
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
        provider: 'ssh',
        options: unsupported,
      });
    }
    return this.uncertainMutation('rm', async () => {
      const sftp = await this.getSftp();
      return new Promise<void>((resolve, reject) => {
        sftp.unlink(filePath, (unlinkErr) => {
          if (!unlinkErr) return resolve();
          sftp.rmdir(filePath, (rmdirErr) =>
            rmdirErr ? reject(rmdirErr) : resolve(),
          );
        });
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
  ): Promise<SshShellResult> {
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
        let abort: () => void;
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          options?.signal?.removeEventListener('abort', abort);
        };

        const finish = (result: SshShellResult) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(result);
        };
        abort = () => {
          const message =
            '[flue:ssh] Command was aborted; the remote process was not confirmed stopped.';
          finish({
            stdout,
            stderr: `${stderr}\n${message}`,
            exitCode: 124,
            uncertainty: { kind: 'abort', message },
          });
          stream.close();
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
            const message = `[flue:ssh] Output exceeded ${this.maxOutputBytes} bytes and was truncated; the remote process was not confirmed stopped.`;
            finish({
              stdout,
              stderr: `${stderr}\n${message}`,
              exitCode: 124,
              uncertainty: { kind: 'output-limit', message },
            });
            stream.close();
          }
        };
        if (typeof options?.timeoutMs === 'number') {
          timer = setTimeout(() => {
            const message = `[flue:ssh] Command timed out after ${options.timeoutMs} milliseconds; the remote process was not confirmed stopped.`;
            finish({
              stdout,
              stderr: `${stderr}\n${message}`,
              exitCode: 124,
              uncertainty: { kind: 'timeout', message },
            });
            stream.close();
          }, options.timeoutMs);
        }

        stream.on('data', (data: Buffer) => {
          append('stdout', data);
        });
        stream.stderr.on('data', (data: Buffer) => {
          append('stderr', data);
        });
        stream.on('close', (code: number | undefined, signal?: string) => {
          if (code === undefined) {
            const message = `SSH command closed without an exit status${signal ? ` (signal ${signal})` : ''}; the remote process was not confirmed stopped.`;
            finish({
              stdout,
              stderr: `${stderr}\n${message}`,
              exitCode: 124,
              uncertainty: { kind: 'transport', message },
            });
            return;
          }
          finish({ stdout, stderr, exitCode: code });
        });
        stream.on('error', (streamErr: Error) => {
          if (settled) return;
          const message = `SSH command stream failed after launch; the remote process was not confirmed stopped: ${streamErr.message}`;
          finish({
            stdout,
            stderr: `${stderr}\n${message}`,
            exitCode: 124,
            uncertainty: { kind: 'transport', message },
          });
        });
        if (options?.signal?.aborted) abort();
        else options?.signal?.addEventListener('abort', abort, { once: true });
      });
    });
  }
}

function sshAbortError(reason: unknown) {
  const error = new DOMException(
    '[flue:ssh] Command was aborted; the remote process may still be running.',
    'AbortError',
  );
  Object.defineProperty(error, 'cause', { value: reason });
  return error;
}

function isMissingParentError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: string | number }).code;
  return code === 'ENOENT' || code === 2;
}

/**
 * Produces the conforming Flue Sandbox surface without sandboxFromDriver's
 * intentionally broad write retry. An uncertain SFTP write is never followed
 * by mkdir/retry because the first remote effect may already have happened.
 */
export function sshSandboxFromDriver(
  api: SshSandboxDriver,
  cwd: string,
): Sandbox {
  const sandboxCwd = path.posix.resolve(cwd);
  const resolvePath = (value: string) =>
    path.posix.resolve(sandboxCwd, value || '.');
  const exec = (
    command: string,
    options?: Parameters<Sandbox['exec']>[1],
  ): Promise<ShellResult> => {
    const signal = options?.signal;
    return new Promise<ShellResult>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const onAbort = () => finish(() => reject(sshAbortError(signal?.reason)));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      void api
        .exec(command, {
          ...options,
          cwd: resolvePath(options?.cwd ?? sandboxCwd),
        })
        .then(
          (result) => finish(() => resolve(result)),
          (error) => finish(() => reject(error)),
        );
    });
  };
  return {
    cwd: sandboxCwd,
    resolvePath,
    exec,
    readFile: (value) => api.readFile(resolvePath(value)),
    readFileBuffer: (value) => api.readFileBuffer(resolvePath(value)),
    async writeFile(value, content) {
      const resolved = resolvePath(value);
      try {
        await api.writeFile(resolved, content);
      } catch (error) {
        if (
          isSshOperationUncertainError(error) ||
          !isMissingParentError(error)
        ) {
          throw error;
        }
        await api.mkdir(path.posix.dirname(resolved), { recursive: true });
        await api.writeFile(resolved, content);
      }
    },
    stat: (value) => api.stat(resolvePath(value)),
    readdir: (value) => api.readdir(resolvePath(value)),
    async exists(value) {
      try {
        return await api.exists(resolvePath(value));
      } catch {
        return false;
      }
    },
    mkdir: (value, mkdirOptions) => api.mkdir(resolvePath(value), mkdirOptions),
    rm: (value, rmOptions) => api.rm(resolvePath(value), rmOptions),
  };
}

export function exedev(
  vm: ExeDevVm | string,
  options?: ExeDevAdapterOptions,
): SandboxFactory {
  return sshSandbox(vm, options);
}

export function sshSandbox(
  vm: SshHost | string,
  options?: SshAdapterOptions,
): SandboxFactory {
  const resolvedVm = typeof vm === 'string' ? { host: vm } : vm;
  return {
    async createSandbox(): Promise<Sandbox> {
      const { env } = await createSshSandbox(resolvedVm, options);
      return env;
    },
  };
}

export async function createSshSandbox(
  vm: SshHost | string,
  options?: SshAdapterOptions,
): Promise<{ env: Sandbox; dispose: () => void }> {
  const resolvedVm = typeof vm === 'string' ? { host: vm } : vm;
  const { ssh, disconnect } = await sshConnect(resolvedVm, options ?? {});
  const api = new SshSandboxDriver(
    ssh,
    options?.maxOutputBytes ?? defaultMaxOutputBytes,
    options?.operationTimeoutMs ?? defaultOperationTimeoutMs,
    options?.maxWriteBytes ?? defaultMaxWriteBytes,
    options?.maxReadBytes ?? defaultMaxReadBytes,
  );

  let sandboxCwd = '/home/user';
  try {
    const result = await api.exec('printf %s "$HOME"', { timeoutMs: 10_000 });
    const uncertainty = sshCommandUncertainty(result);
    if (uncertainty) {
      throw new ExeDevError(
        `SSH HOME discovery did not settle: ${uncertainty.message}`,
      );
    }
    if (result.exitCode !== 0) {
      throw new ExeDevError(
        `SSH HOME discovery failed: ${result.stderr.trim() || `exit ${result.exitCode}`}.`,
      );
    }
    const detected = result.stdout.trim();
    if (!detected.startsWith('/') || detected === '/') {
      throw new ExeDevError('SSH HOME discovery returned an unsafe path.');
    }
    sandboxCwd = detected;
  } catch (error) {
    disconnect();
    throw error;
  }

  const env = sshSandboxFromDriver(api, sandboxCwd);
  return { env, dispose: disconnect };
}
