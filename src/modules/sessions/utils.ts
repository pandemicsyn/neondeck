export type FailedSessionResult = {
  ok: false;
  action: string;
  changed: false;
  message: string;
  errors: string[];
  requires?: string[];
};

export function failedSessionResult(
  action: string,
  message: string,
  requires?: string[],
) {
  const result: FailedSessionResult = {
    ok: false,
    action,
    changed: false,
    message,
    errors: [message],
  };
  if (requires) result.requires = requires;
  return result;
}

export function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
