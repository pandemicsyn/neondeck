/* eslint-disable no-unused-vars */
import { type JsonValue } from '@flue/runtime';
import * as v from 'valibot';
import { type GitHubPullRequestEventState } from '../../github';
import { readRepoRegistrySnapshot } from '../../repos';
import { AutopilotActionResult } from './schemas';

export function parseInput<
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(
  schema: TSchema,
  rawInput: unknown,
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
  return {
    ok: false,
    action,
    changed: false,
    message,
    ...(details.errors ? { errors: details.errors } : {}),
    ...(details.requires ? { requires: details.requires } : {}),
  };
}

export function lowerLevelFailure(
  action: string,
  sourceAction: string,
  result: unknown,
): AutopilotActionResult {
  const message =
    stringField(result, 'message') ??
    `Could not prepare PR worktree because ${sourceAction} failed.`;
  return {
    ok: false,
    action,
    changed: Boolean(booleanField(result, 'changed')),
    message,
    errors: [message],
    error: asJsonValue({
      sourceAction,
      sourceMessage: message,
      sourceError:
        result && typeof result === 'object'
          ? (result as Record<string, unknown>).error
          : undefined,
    }),
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

export function objectField(value: unknown, key: string) {
  if (!value || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return field && typeof field === 'object' ? field : undefined;
}

export function stringField(value: unknown, key: string) {
  if (!value || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : undefined;
}

export function booleanField(value: unknown, key: string) {
  if (!value || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'boolean' ? field : undefined;
}

export function numberField(value: unknown, key: string) {
  if (!value || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'number' ? field : undefined;
}

export function arrayField(value: unknown, key: string) {
  if (!value || typeof value !== 'object') return [];
  const field = (value as Record<string, unknown>)[key];
  return Array.isArray(field)
    ? field.filter((item): item is string => typeof item === 'string')
    : [];
}

export function numberArrayField(value: unknown, key: string) {
  if (!value || typeof value !== 'object') return [];
  const field = (value as Record<string, unknown>)[key];
  return Array.isArray(field)
    ? field.filter((item): item is number => typeof item === 'number')
    : [];
}

export function isAutopilotActionResult(
  value: GitHubPullRequestEventState | AutopilotActionResult,
): value is AutopilotActionResult {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    'ok' in value &&
    'action' in value
  );
}

export function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
