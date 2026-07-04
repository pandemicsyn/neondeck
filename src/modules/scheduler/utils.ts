import { failedAction } from '../../lib/action-result';
import { asJsonValue } from '../../lib/action-result';
import { parseInput as parseSharedInput } from '../../lib/valibot';
import type { JobRecord } from '../app-state';
import type { SchedulerResult } from './schemas';
import type * as v from 'valibot';

export function parseActionInput<T>(
  schema: v.GenericSchema<unknown, T>,
  input: unknown,
  action: string,
) {
  return parseSharedInput(schema, input, (message) =>
    failResult(action, 'Invalid action input.', {
      errors: [message],
    }),
  );
}

export function okResult(
  action: string,
  changed: boolean,
  outcome: string | undefined,
  message: string,
  data: {
    jobs?: JobRecord[];
    notifications?: unknown[];
    extra?: unknown;
  } = {},
): SchedulerResult {
  return {
    ok: true,
    action,
    changed,
    ...(outcome ? { outcome } : {}),
    message,
    ...(data.jobs ? { jobs: data.jobs.map(asJsonValue) } : {}),
    ...(data.notifications
      ? { notifications: data.notifications.map(asJsonValue) }
      : {}),
    ...(data.extra ? { extra: asJsonValue(data.extra) } : {}),
  } as SchedulerResult;
}

export const failResult = failedAction<
  Pick<SchedulerResult, 'errors' | 'requires'>
>;

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
