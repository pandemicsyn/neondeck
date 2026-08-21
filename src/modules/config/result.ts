import { asJsonValue } from '../../lib/action-result';
import type { RuntimePaths } from '../../runtime-home';
import * as v from 'valibot';
import type { ConfigActionResult, ConfigExternalValue } from './schemas';

const errorSchema = v.instance(Error);

export function okResult(
  action: string,
  changed: boolean,
  paths: RuntimePaths,
  files: string[],
  details: { message: string; data?: ConfigExternalValue },
): ConfigActionResult {
  const result: ConfigActionResult = {
    ok: true,
    action,
    changed,
    message: details.message,
    home: paths.home,
    files,
  };
  if (details.data !== undefined) result.data = asJsonValue(details.data);
  return result;
}

export function failResult(
  action: string,
  paths: RuntimePaths,
  files: string[],
  details: Pick<ConfigActionResult, 'message' | 'errors' | 'requires'>,
): ConfigActionResult {
  const result: ConfigActionResult = {
    ok: false,
    action,
    changed: false,
    message: details.message,
    home: paths.home,
    files,
  };
  if (details.errors) result.errors = details.errors;
  if (details.requires) result.requires = details.requires;
  return result;
}

export function parseActionInput<T>(
  schema: v.GenericSchema<ConfigExternalValue, T>,
  input: ConfigExternalValue,
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

export function errorMessage(error: ConfigExternalValue) {
  const parsed = v.safeParse(errorSchema, error);
  return parsed.success ? parsed.output.message : String(error);
}
