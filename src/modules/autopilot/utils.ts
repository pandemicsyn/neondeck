/* eslint-disable no-unused-vars */
import * as v from 'valibot';
import { asJsonValue as serializeJsonValue } from '../../lib/action-result';
import { type GitHubPullRequestEventState } from '../github';
import { readRepoRegistrySnapshot } from '../repos';
import { AutopilotActionResult, autopilotOutputSchema } from './schemas';

const untrustedInputSchema = v.unknown();
const looseObjectSchema = v.looseObject({});
const errorInstanceSchema = v.instance(Error);
const errorTextSchema = v.string();
const errorObjectSchema = v.object({ message: v.string() });

type UntrustedInput = v.InferInput<typeof untrustedInputSchema>;
type LowerLevelFailureError = {
  sourceAction: string;
  sourceMessage: string;
  sourceError?: ReturnType<typeof serializeJsonValue>;
};

export function parseInput<
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(
  schema: TSchema,
  rawInput: UntrustedInput,
  action: string,
):
  | { ok: true; input: v.InferOutput<TSchema> }
  | { ok: false; result: AutopilotActionResult } {
  const parsed = v.safeParse(schema, rawInput);
  if (parsed.success) return { ok: true, input: parsed.output };
  return {
    ok: false,
    result: failResult(action, 'Invalid autopilot input.', {
      errors: [v.summarize(parsed.issues)],
    }),
  };
}

export function failResult(
  action: string,
  message: string,
  details: Pick<AutopilotActionResult, 'errors' | 'requires'> = {},
): AutopilotActionResult {
  const result: AutopilotActionResult = {
    ok: false,
    action,
    changed: false,
    message,
  };
  if (details.errors) result.errors = details.errors;
  if (details.requires) result.requires = details.requires;
  return result;
}

export function lowerLevelFailure(
  action: string,
  sourceAction: string,
  result: UntrustedInput,
): AutopilotActionResult {
  const message =
    stringField(result, 'message') ??
    `Could not prepare PR worktree because ${sourceAction} failed.`;
  const error: LowerLevelFailureError = {
    sourceAction,
    sourceMessage: message,
  };
  const sourceError = fieldInput(result, 'error');
  if (sourceError !== undefined) {
    error.sourceError = serializeJsonValue(sourceError);
  }
  return {
    ok: false,
    action,
    changed: Boolean(booleanField(result, 'changed')),
    message,
    errors: [message],
    error: serializeJsonValue(error),
  };
}

export function resolveVerificationChecks(
  inputChecks: string[] | undefined,
  repo: Awaited<ReturnType<typeof readRepoRegistrySnapshot>>['repos'][number],
  policyChecks: string[],
) {
  if (policyChecks.length > 0) {
    return unique([...policyChecks, ...(inputChecks ?? [])]);
  }
  if (inputChecks && inputChecks.length > 0) return unique(inputChecks);

  const scripts = repo.packageScripts ?? {};
  const preferred = ['check', 'test', 'typecheck', 'lint'];
  return preferred
    .filter((script) => scripts[script])
    .map((script) => `npm run ${script}`);
}

export function unique(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function fieldInput(value: UntrustedInput, key: string) {
  const parsed = v.safeParse(looseObjectSchema, value);
  return parsed.success ? parsed.output[key] : undefined;
}

export function objectField(value: UntrustedInput, key: string) {
  const parsed = v.safeParse(looseObjectSchema, fieldInput(value, key));
  return parsed.success ? parsed.output : undefined;
}

export function stringField(value: UntrustedInput, key: string) {
  const parsed = v.safeParse(v.string(), fieldInput(value, key));
  return parsed.success ? parsed.output : undefined;
}

export function booleanField(value: UntrustedInput, key: string) {
  const parsed = v.safeParse(v.boolean(), fieldInput(value, key));
  return parsed.success ? parsed.output : undefined;
}

export function numberField(value: UntrustedInput, key: string) {
  const parsed = v.safeParse(v.number(), fieldInput(value, key));
  return parsed.success ? parsed.output : undefined;
}

export function arrayField(value: UntrustedInput, key: string) {
  const parsed = v.safeParse(v.array(v.string()), fieldInput(value, key));
  return parsed.success ? parsed.output : [];
}

export function numberArrayField(value: UntrustedInput, key: string) {
  const parsed = v.safeParse(v.array(v.number()), fieldInput(value, key));
  return parsed.success ? parsed.output : [];
}

export function isAutopilotActionResult(
  value: GitHubPullRequestEventState | AutopilotActionResult,
): value is AutopilotActionResult {
  return v.safeParse(autopilotOutputSchema, value).success;
}

export { serializeJsonValue as asJsonValue };

export function errorMessage(error: UntrustedInput) {
  const instance = v.safeParse(errorInstanceSchema, error);
  if (instance.success) return instance.output.message;
  const text = v.safeParse(errorTextSchema, error);
  if (text.success) return text.output;
  const object = v.safeParse(errorObjectSchema, error);
  return object.success ? object.output.message : String(error);
}
