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
  const stdout = sanitizeOutput(String(input.stdout ?? ''), input.outputLimit);
  const stderr = sanitizeOutput(String(input.stderr ?? ''), input.outputLimit);
  return {
    exitCode: input.exitCode,
    stdout: stdout.content,
    stderr: stderr.content,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    stdoutRedacted: stdout.redacted,
    stderrRedacted: stderr.redacted,
    durationMs: input.durationMs,
  };
}

export function sanitizeExecutionText(value: string, limit: number) {
  const redacted = redactExecutionOutput(value);
  const bytes = Buffer.from(redacted, 'utf8');
  if (bytes.byteLength <= limit) {
    return {
      content: redacted,
      truncated: false,
      redacted: redacted !== value,
    };
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let end = limit;
  while (end > 0) {
    try {
      return {
        content: decoder.decode(bytes.subarray(0, end)),
        truncated: true,
        redacted: redacted !== value,
      };
    } catch {
      end -= 1;
    }
  }
  return { content: '', truncated: true, redacted: redacted !== value };
}

const sanitizeOutput = sanitizeExecutionText;

export function redactExecutionOutput(value: string) {
  return value
    .replace(/gh[pousr]_[A-Za-z0-9_]*/g, '[redacted-github-token]')
    .replace(/github_pat_[A-Za-z0-9_]*/g, '[redacted-github-token]')
    .replace(/sk-[A-Za-z0-9_-]*/g, '[redacted-api-key]')
    .replace(/xox[baprs]-[A-Za-z0-9-]*/g, '[redacted-token]');
}

export function commandError(error: unknown) {
  const record =
    error && typeof error === 'object'
      ? (error as Record<string, unknown>)
      : {};
  const code = record.code;
  const signal = record.signal;
  const exitCode = typeof code === 'number' ? code : null;
  const rawMessage =
    error instanceof Error
      ? error.message
      : `Command failed${signal ? ` with signal ${String(signal)}` : ''}.`;
  return {
    message: sanitizeExecutionText(rawMessage, 16 * 1024).content,
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
    message: sanitizeExecutionText(message, 16 * 1024).content,
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
