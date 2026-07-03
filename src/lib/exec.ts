import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ExecFileOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxBuffer?: number;
};

export type ExecFileOutput = {
  stdout: string;
  stderr: string;
};

export class ExecFileError extends Error {
  readonly code: string | number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;

  constructor(
    message: string,
    details: {
      code?: string | number | null;
      signal?: NodeJS.Signals | null;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      timedOut?: boolean;
      cause?: unknown;
    },
  ) {
    super(message, { cause: details.cause });
    this.name = 'ExecFileError';
    this.code = details.code ?? null;
    this.signal = details.signal ?? null;
    this.stdout = outputText(details.stdout);
    this.stderr = outputText(details.stderr);
    this.timedOut = Boolean(details.timedOut);
  }
}

export async function runExecFile(
  file: string,
  args: string[] = [],
  options: ExecFileOptions = {},
): Promise<ExecFileOutput> {
  try {
    const result = await execFileAsync(file, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      signal: options.signal,
      maxBuffer: options.maxBuffer,
      encoding: 'utf8',
    });
    return {
      stdout: outputText(result.stdout),
      stderr: outputText(result.stderr),
    };
  } catch (error) {
    throw normalizeExecFileError(error, file, args);
  }
}

export function normalizeExecFileError(
  error: unknown,
  file = 'command',
  args: string[] = [],
) {
  if (error instanceof ExecFileError) return error;
  if (error && typeof error === 'object') {
    const record = error as {
      message?: unknown;
      code?: unknown;
      signal?: unknown;
      stdout?: unknown;
      stderr?: unknown;
      killed?: unknown;
    };
    return new ExecFileError(
      typeof record.message === 'string'
        ? record.message
        : `${[file, ...args].join(' ')} failed.`,
      {
        code:
          typeof record.code === 'string' || typeof record.code === 'number'
            ? record.code
            : null,
        signal:
          typeof record.signal === 'string'
            ? (record.signal as NodeJS.Signals)
            : null,
        stdout:
          typeof record.stdout === 'string' || Buffer.isBuffer(record.stdout)
            ? record.stdout
            : '',
        stderr:
          typeof record.stderr === 'string' || Buffer.isBuffer(record.stderr)
            ? record.stderr
            : '',
        timedOut: record.killed === true && record.signal === 'SIGTERM',
        cause: error,
      },
    );
  }
  return new ExecFileError(`${[file, ...args].join(' ')} failed.`, {
    cause: error,
  });
}

function outputText(value: string | Buffer | undefined) {
  return typeof value === 'string' ? value : (value?.toString('utf8') ?? '');
}
