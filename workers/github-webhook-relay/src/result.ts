// Shared shape for the `{ ok: false, status, code, error }` failure results
// returned by `verifyGithubWebhook` and `authenticateWebSocketRequest`.
// Generic so each call site keeps its own narrow `status`/`code` literal
// union instead of widening to `number`/`string` — see the two modules'
// local `failure()` wrappers, which pin the exact union for their own
// result type and delegate the object construction here.
export function failureResult<Status extends number, Code extends string>(
  status: Status,
  code: Code,
  error: string,
): { ok: false; status: Status; code: Code; error: string } {
  return { ok: false, status, code, error };
}
