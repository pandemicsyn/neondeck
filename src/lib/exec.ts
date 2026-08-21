import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as v from 'valibot';

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

const nodeSignalSchema = v.picklist([
  'SIGHUP',
  'SIGINT',
  'SIGQUIT',
  'SIGILL',
  'SIGTRAP',
  'SIGABRT',
  'SIGIOT',
  'SIGBUS',
  'SIGFPE',
  'SIGKILL',
  'SIGUSR1',
  'SIGSEGV',
  'SIGUSR2',
  'SIGPIPE',
  'SIGALRM',
  'SIGTERM',
  'SIGCHLD',
  'SIGSTKFLT',
  'SIGCONT',
  'SIGSTOP',
  'SIGTSTP',
  'SIGTTIN',
  'SIGTTOU',
  'SIGURG',
  'SIGXCPU',
  'SIGXFSZ',
  'SIGVTALRM',
  'SIGPROF',
  'SIGWINCH',
  'SIGIO',
  'SIGPOLL',
  'SIGPWR',
  'SIGSYS',
  'SIGBREAK',
  'SIGLOST',
  'SIGINFO',
]);

const execFileErrorSchema = v.looseObject({
  message: v.optional(v.string()),
  code: v.optional(v.union([v.string(), v.number(), v.null()])),
  signal: v.optional(nodeSignalSchema),
  stdout: v.optional(v.union([v.string(), v.instance(Buffer)])),
  stderr: v.optional(v.union([v.string(), v.instance(Buffer)])),
  killed: v.optional(v.boolean()),
});

export function normalizeExecFileError<TError>(
  error: TError,
  file = 'command',
  args: string[] = [],
) {
  if (error instanceof ExecFileError) return error;
  const parsed = v.safeParse(execFileErrorSchema, error);
  if (parsed.success) {
    const record = parsed.output;
    return new ExecFileError(
      record.message ?? `${[file, ...args].join(' ')} failed.`,
      {
        code: record.code ?? null,
        signal: record.signal ?? null,
        stdout: record.stdout ?? '',
        stderr: record.stderr ?? '',
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
  return Buffer.isBuffer(value) ? value.toString('utf8') : (value ?? '');
}
