import { asJsonValue } from '../../lib/action-result';
import type { NeonCommandName, NeonCommandResult } from './schemas';
import * as v from 'valibot';

const reviewQueueSummarySchema = v.looseObject({
  fetchedAt: v.optional(v.unknown()),
  login: v.optional(v.unknown()),
  repos: v.optional(v.unknown()),
  count: v.optional(v.unknown()),
  truncated: v.optional(v.unknown()),
  issues: v.optional(v.unknown()),
  triage: v.optional(v.unknown()),
  topActions: v.optional(v.unknown()),
});

type CommandFailureDetails<TData> = Pick<
  NeonCommandResult,
  'errors' | 'requires'
> & { data?: TData };

export function compactCommandSummary(result: NeonCommandResult) {
  const parsed = v.safeParse(reviewQueueSummarySchema, result.data);
  if (result.command === 'review-queue' && parsed.success) {
    const data = parsed.output;

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

export function completedCommand<TData>(
  command: NeonCommandName,
  input: string,
  message: string,
  data: TData,
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

export function runningCommand<TData>(
  command: NeonCommandName,
  input: string,
  message: string,
  data: TData,
): NeonCommandResult {
  return {
    ok: true,
    command,
    input,
    status: 'running',
    message,
    data: asJsonValue(data),
  };
}

export function needsConfigCommand<TData>(
  command: NeonCommandName,
  input: string,
  message: string,
  details: CommandFailureDetails<TData>,
): NeonCommandResult {
  const result: NeonCommandResult = {
    ok: false,
    command,
    input,
    status: 'needs-config',
    message,
  };
  if (details.errors) result.errors = details.errors;
  if (details.requires) result.requires = details.requires;
  if (details.data) result.data = asJsonValue(details.data);
  return result;
}

export function failedCommand<TData>(
  command: NeonCommandName,
  input: string,
  message: string,
  details?: CommandFailureDetails<TData>,
): NeonCommandResult {
  const result: NeonCommandResult = {
    ok: false,
    command,
    input,
    status: 'failed',
    message,
  };
  if (details?.errors) result.errors = details.errors;
  if (details?.requires) result.requires = details.requires;
  if (details?.data) result.data = asJsonValue(details.data);
  return result;
}
