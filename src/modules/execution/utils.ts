import { type JsonValue } from '@flue/runtime';
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

export function commandError(error: unknown) {
  const record =
    error && typeof error === 'object'
      ? (error as Record<string, unknown>)
      : {};
  const code = record.code;
  const signal = record.signal;
  const exitCode = typeof code === 'number' ? code : null;
  const message =
    error instanceof Error
      ? error.message
      : `Command failed${signal ? ` with signal ${String(signal)}` : ''}.`;
  return {
    message,
    exitCode,
    stdout: record.stdout ?? '',
    stderr: record.stderr ?? '',
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

export function isJsonValue(value: unknown): value is JsonValue {
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}
