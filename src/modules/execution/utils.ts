import { type JsonValue } from '@flue/runtime';
import * as v from 'valibot';
import { safeEnvKeys } from './schemas';

export function splitCommand(
  input: string,
): { ok: true; file: string; args: string[] } | { ok: false; message: string } {
  const parts = input.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const parsed = parts.map((part) =>
    (part.startsWith('"') && part.endsWith('"')) ||
    (part.startsWith("'") && part.endsWith("'"))
      ? part.slice(1, -1)
      : part,
  );
  const [file, ...args] = parsed;
  if (!file) return { ok: false, message: 'A command executable is required.' };
  return { ok: true, file, args };
}

export function hasShellOperator(value: string) {
  return /(?:\n|&&|\|\||[;&|<>`]|\$\()/.test(value);
}

export function safeExecutionEnv() {
  const env: NodeJS.ProcessEnv = {};
  for (const key of safeEnvKeys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function executionResult(input: {
  stdout: unknown;
  stderr: unknown;
  exitCode: number | null;
  durationMs: number;
  outputLimit: number;
}) {
  const stdout = truncateOutput(String(input.stdout ?? ''), input.outputLimit);
  const stderr = truncateOutput(String(input.stderr ?? ''), input.outputLimit);
  return {
    exitCode: input.exitCode,
    stdout,
    stderr,
    stdoutTruncated: stdout.length < String(input.stdout ?? '').length,
    stderrTruncated: stderr.length < String(input.stderr ?? '').length,
    durationMs: input.durationMs,
  };
}

function truncateOutput(value: string, limit: number) {
  if (value.length <= limit) return redactOutput(value);
  return redactOutput(value.slice(0, limit));
}

function redactOutput(value: string) {
  return value
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, '[redacted-github-token]')
    .replace(/github_pat_[A-Za-z0-9_]+/g, '[redacted-github-token]')
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, '[redacted-api-key]')
    .replace(/xox[baprs]-[A-Za-z0-9-]+/g, '[redacted-token]');
}

const commandErrorSchema = v.looseObject({
  code: v.optional(v.unknown()),
  signal: v.optional(v.unknown()),
  stdout: v.optional(v.unknown()),
  stderr: v.optional(v.unknown()),
});

export function commandError<TError>(error: TError) {
  const parsed = v.safeParse(commandErrorSchema, error);
  const record = parsed.success ? parsed.output : {};
  const code = v.safeParse(v.number(), record.code);
  const signal = v.safeParse(v.string(), record.signal);
  const stdout = v.safeParse(v.string(), record.stdout);
  const stderr = v.safeParse(v.string(), record.stderr);
  const exitCode = code.success ? code.output : null;
  const message =
    error instanceof Error
      ? error.message
      : `Command failed${signal.success ? ` with signal ${signal.output}` : ''}.`;
  return {
    message,
    exitCode,
    stdout: stdout.success ? stdout.output : '',
    stderr: stderr.success ? stderr.output : '',
  };
}

export function failedResult(
  action: string,
  message: string,
  requires: string[],
) {
  return {
    ok: false,
    action,
    changed: false,
    message,
    requires,
  };
}

export function isJsonValue<TValue>(
  value: TValue,
): value is TValue & JsonValue {
  try {
    return v.safeParse(executionJsonValueSchema, value).success;
  } catch {
    return false;
  }
}

const executionJsonValueSchema: v.GenericSchema<unknown, JsonValue> = v.lazy(
  () =>
    v.union([
      v.null(),
      v.boolean(),
      v.pipe(v.number(), v.finite()),
      v.string(),
      v.array(executionJsonValueSchema),
      v.pipe(
        v.unknown(),
        v.check((value) => {
          if (Array.isArray(value)) return false;
          const record = v.safeParse(v.record(v.string(), v.unknown()), value);
          if (!record.success) return false;
          const prototype = Object.getPrototypeOf(value);
          return prototype === Object.prototype || prototype === null;
        }, 'Value must be a plain JSON object.'),
        v.record(v.string(), executionJsonValueSchema),
      ),
    ]),
);
