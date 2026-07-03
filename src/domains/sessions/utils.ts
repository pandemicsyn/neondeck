export function failedSessionResult(
  action: string,
  message: string,
  requires?: string[],
) {
  return {
    ok: false,
    action,
    changed: false,
    message,
    errors: [message],
    ...(requires ? { requires } : {}),
  };
}

export function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
