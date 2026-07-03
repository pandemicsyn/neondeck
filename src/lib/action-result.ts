import { type JsonValue } from '@flue/runtime';

type ActionDetails = {
  errors?: string[];
  requires?: string[];
};

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
