import { type JsonValue } from '@flue/runtime';

export type ActionDetails = {
  errors?: string[];
  requires?: string[];
};

type FailedActionLike = ActionDetails & {
  action?: string;
  message: string;
};

type FailedActionResult = {
  ok: false;
  action: string;
  changed: false;
  message: string;
  errors?: string[];
  requires?: string[];
};

export class ActionResultError extends Error {
  readonly action?: string;
  readonly errors?: string[];
  readonly requires?: string[];

  constructor(result: FailedActionLike) {
    super(result.message);
    this.name = 'ActionResultError';
    this.action = result.action;
    this.errors = result.errors;
    this.requires = result.requires;
  }
}

export function actionResultErrorDetails<TError>(error: TError): ActionDetails {
  if (!(error instanceof ActionResultError)) return {};
  const details: ActionDetails = {};
  if (error.errors) details.errors = error.errors;
  if (error.requires) details.requires = error.requires;
  return details;
}

export function okAction<TExtra extends object = never>(
  action: string,
  changed: boolean,
  message: string,
  extra?: TExtra,
) {
  return {
    ok: true as const,
    action,
    changed,
    message,
    ...extra,
  };
}

export function failedAction<TDetails extends ActionDetails = ActionDetails>(
  action: string,
  message: string,
  details?: TDetails,
) {
  const result: FailedActionResult = {
    ok: false as const,
    action,
    changed: false as const,
    message,
  };
  if (details?.errors) result.errors = details.errors;
  if (details?.requires) result.requires = details.requires;
  return result;
}

export function invalidInputAction(action: string, message: string) {
  return {
    ok: false as const,
    action,
    changed: false as const,
    message,
    errors: [message],
    error: { code: 'INVALID_INPUT', message },
  };
}

export function asJsonValue<TValue>(value: TValue): JsonValue {
  return JSON.parse(JSON.stringify(value));
}
