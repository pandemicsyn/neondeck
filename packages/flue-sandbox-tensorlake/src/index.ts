import { sandboxFromDriver } from '@flue/runtime';
import type {
  FileStat,
  Sandbox,
  SandboxDriver,
  SandboxFactory,
  ShellResult,
} from '@flue/runtime';
import type { Sandbox as TensorlakeSandbox } from 'tensorlake';

/**
 * Options for adapting an existing Tensorlake sandbox to Flue.
 *
 * Tensorlake sandbox lifecycle is deliberately application-owned: create or
 * connect to the sandbox before calling {@link tensorlake}, then terminate or
 * suspend it when the application is finished with it.
 */
export interface TensorlakeAdapterOptions {
  /** Initial working directory exposed to Flue. Defaults to `/workspace`. */
  cwd?: string;
}

class TensorlakeCommandError extends Error {
  constructor(
    readonly command: string,
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(
      `Tensorlake sandbox command ${JSON.stringify(command)} exited with code ${exitCode}${stderr ? `: ${stderr}` : ''}`,
    );
    this.name = 'TensorlakeCommandError';
  }
}

/**
 * Implements Flue's filesystem and shell boundary with a Tensorlake sandbox.
 *
 * Tensorlake's SDK provides native command and file primitives. `stat`,
 * `exists`, `mkdir`, and `rm` use argv-based commands because the SDK has no
 * corresponding methods. Paths are always passed as arguments, never spliced
 * into shell text.
 */
export class TensorlakeSandboxDriver implements SandboxDriver {
  constructor(private readonly sandbox: TensorlakeSandbox) {}

  async exec(
    command: string,
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<ShellResult> {
    const timeout = options?.timeoutMs;
    const result = await this.sandbox.run('bash', {
      args: ['-lc', command],
      ...(options?.cwd === undefined ? {} : { workingDir: options.cwd }),
      ...(options?.env === undefined ? {} : { env: options.env }),
      ...(timeout === undefined ? {} : { timeout: Math.ceil(timeout / 1000) }),
    });

    return {
      exitCode: result.exitCode,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  }

  async readFile(filePath: string): Promise<string> {
    return new TextDecoder().decode(await this.readFileBuffer(filePath));
  }

  async readFileBuffer(filePath: string): Promise<Uint8Array> {
    return this.sandbox.readFile(filePath);
  }

  async writeFile(
    filePath: string,
    content: string | Uint8Array,
  ): Promise<void> {
    await this.sandbox.writeFile(
      filePath,
      typeof content === 'string' ? new TextEncoder().encode(content) : content,
    );
  }

  async readdir(dirPath: string): Promise<string[]> {
    const response = await this.sandbox.listDirectory(dirPath);
    return response.entries.map((entry) => entry.name);
  }

  async stat(filePath: string): Promise<FileStat> {
    const statArgs = ['--printf=%f\\t%s\\t%Y', '--', filePath];
    const result = await this.runChecked('stat', statArgs);
    const fileStat = this.parseStatOutput(filePath, result.stdout);

    if (!fileStat.isSymbolicLink) return fileStat;

    const targetResult = await this.runChecked('stat', ['-L', ...statArgs]);
    return {
      ...this.parseStatOutput(filePath, targetResult.stdout),
      isSymbolicLink: true,
    };
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
    await this.runChecked('mkdir', [
      ...(options?.recursive ? ['-p'] : []),
      '--',
      dirPath,
    ]);
  }

  async rm(
    filePath: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void> {
    await this.runChecked('rm', [
      ...(options?.recursive ? ['-r'] : []),
      ...(options?.force ? ['-f'] : []),
      '--',
      filePath,
    ]);
  }

  private parseStatOutput(filePath: string, output: string): FileStat {
    const [modeText, size, modifiedAt] = output.split('\t');
    const mode =
      modeText !== undefined && /^[0-9a-f]+$/i.test(modeText)
        ? Number.parseInt(modeText, 16)
        : Number.NaN;
    const mtimeSeconds = Number(modifiedAt);
    const parsedSize = Number(size);

    if (
      !Number.isFinite(mode) ||
      !Number.isFinite(parsedSize) ||
      !Number.isFinite(mtimeSeconds)
    ) {
      throw new Error(
        `Unable to parse stat output for ${JSON.stringify(filePath)}`,
      );
    }

    const fileType = mode & 0xf000;
    return {
      isDirectory: fileType === 0x4000,
      isFile: fileType === 0x8000,
      isSymbolicLink: fileType === 0xa000,
      mtime: new Date(mtimeSeconds * 1000),
      size: parsedSize,
    };
  }

  private async runChecked(
    command: string,
    args: string[],
  ): Promise<ShellResult> {
    const result = await this.sandbox.run(command, { args });
    if (result.exitCode !== 0) {
      throw new TensorlakeCommandError(command, result.exitCode, result.stderr);
    }
    return result;
  }
}

/**
 * Adapt an already-created Tensorlake sandbox for Flue.
 *
 * This mirrors Flue's provider adapters: it only wraps a live SDK handle and
 * never creates, resumes, suspends, or terminates remote infrastructure.
 */
export function tensorlake(
  sandbox: TensorlakeSandbox,
  options?: TensorlakeAdapterOptions,
): SandboxFactory {
  return {
    async createSandbox(): Promise<Sandbox> {
      return sandboxFromDriver(
        new TensorlakeSandboxDriver(sandbox),
        options?.cwd ?? '/workspace',
      );
    },
  };
}
