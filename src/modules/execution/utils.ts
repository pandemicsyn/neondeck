import { type JsonValue } from '@flue/runtime';
import { safeEnvKeys } from './schemas';

export { splitCommand, hasShellOperator, executionResult } from './worker';

export function safeExecutionEnv() {
  const env: NodeJS.ProcessEnv = {};
  for (const key of safeEnvKeys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
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
