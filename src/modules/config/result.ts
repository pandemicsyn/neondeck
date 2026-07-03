import { asJsonValue } from '../../lib/action-result';
import type { RuntimePaths } from '../../runtime-home';
import * as v from 'valibot';
import type { ConfigActionResult } from './schemas';

export function okResult(
  action: string,
  changed: boolean,
  paths: RuntimePaths,
  files: string[],
  details: { message: string; data?: unknown },
): ConfigActionResult {
  return {
    ok: true,
    action,
    changed,
    message: details.message,
    home: paths.home,
    files,
    ...(details.data === undefined ? {} : { data: asJsonValue(details.data) }),
  };
}

export function failResult(
  action: string,
  paths: RuntimePaths,
  files: string[],
  details: Pick<ConfigActionResult, 'message' | 'errors' | 'requires'>,
): ConfigActionResult {
  return {
    ok: false,
    action,
    changed: false,
    message: details.message,
    home: paths.home,
    files,
    ...(details.errors ? { errors: details.errors } : {}),
    ...(details.requires ? { requires: details.requires } : {}),
  };
}

export function parseActionInput<T>(
  schema: v.GenericSchema<unknown, T>,
  input: unknown,
  action: string,
  paths: RuntimePaths,
  files: string[],
) {
  const result = v.safeParse(schema, input);

  if (result.success) {
    return { ok: true as const, input: result.output };
  }

  return {
    ok: false as const,
    result: failResult(action, paths, files, {
      message: 'Invalid action input.',
      errors: [v.summarize(result.issues)],
    }),
  };
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
