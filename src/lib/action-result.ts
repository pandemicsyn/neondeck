import { type JsonValue } from '@flue/runtime';

export type ActionDetails = {
  errors?: string[];
  requires?: string[];
};

type FailedActionLike = ActionDetails & {
  action?: string;
  message: string;
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

export function actionResultErrorDetails(error: unknown): ActionDetails {
  if (!(error instanceof ActionResultError)) return {};
  return {
    ...(error.errors ? { errors: error.errors } : {}),
    ...(error.requires ? { requires: error.requires } : {}),
  };
}

export function okAction<TExtra extends Record<string, unknown> = never>(
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
  details: TDetails = {} as TDetails,
) {
  return {
    ok: false as const,
    action,
    changed: false as const,
    message,
    ...(details.errors ? { errors: details.errors } : {}),
    ...(details.requires ? { requires: details.requires } : {}),
  };
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

export function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
