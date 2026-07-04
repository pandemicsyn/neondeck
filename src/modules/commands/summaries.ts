import { asJsonValue } from '../../lib/action-result';
import type { NeonCommandName, NeonCommandResult } from './schemas';

export function compactCommandSummary(result: NeonCommandResult) {
  if (
    result.command === 'review-queue' &&
    result.data &&
    typeof result.data === 'object'
  ) {
    const data = result.data as {
      fetchedAt?: unknown;
      login?: unknown;
      repos?: unknown;
      count?: unknown;
      truncated?: unknown;
      issues?: unknown;
      triage?: unknown;
      topActions?: unknown;
    };

    return {
      ok: result.ok,
      command: result.command,
      input: result.input,
      status: result.status,
      message: result.message,
      fetchedAt: data.fetchedAt,
      login: data.login,
      repos: data.repos,
      count: data.count,
      truncated: data.truncated,
      issues: data.issues,
      triage: data.triage,
      topActions: data.topActions,
    };
  }

  return result;
}

export function completedCommand(
  command: NeonCommandName,
  input: string,
  message: string,
  data: unknown,
): NeonCommandResult {
  return {
    ok: true,
    command,
    input,
    status: 'completed',
    message,
    data: asJsonValue(data),
  };
}

export function needsConfigCommand(
  command: NeonCommandName,
  input: string,
  message: string,
  details: Pick<NeonCommandResult, 'errors' | 'requires'>,
): NeonCommandResult {
  return {
    ok: false,
    command,
    input,
    status: 'needs-config',
    message,
    ...(details.errors ? { errors: details.errors } : {}),
    ...(details.requires ? { requires: details.requires } : {}),
  };
}

export function failedCommand(
  command: NeonCommandName,
  input: string,
  message: string,
  details: Pick<NeonCommandResult, 'errors' | 'requires'> & {
    data?: unknown;
  } = {},
): NeonCommandResult {
  return {
    ok: false,
    command,
    input,
    status: 'failed',
    message,
    ...(details.errors ? { errors: details.errors } : {}),
    ...(details.requires ? { requires: details.requires } : {}),
    ...(details.data ? { data: asJsonValue(details.data) } : {}),
  };
}
