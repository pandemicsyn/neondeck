export class WorktreeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'WorktreeError';
    this.code = code;
  }
}

export function failureResult(action: string, error: UntrustedInput) {
  const message = errorMessage(error);
  return {
    ok: false,
    action,
    changed: false,
    message,
    errors: [message],
    error: {
      code: error instanceof WorktreeError ? error.code : 'WORKTREE_ERROR',
      message,
    },
  };
}

export function errorMessage(error: UntrustedInput) {
  const parsed = v.safeParse(errorInstanceSchema, error);
  if (parsed.success) return parsed.output.message;
  return String(error);
}

export function isSqliteUniqueConstraint(error: UntrustedInput) {
  const parsed = v.safeParse(errorInstanceSchema, error);
  if (!parsed.success) return false;
  const withCode = v.safeParse(errorWithCodeSchema, error);
  return withCode.success
    ? String(withCode.output.code).includes('CONSTRAINT')
    : /constraint/i.test(parsed.output.message);
}
import * as v from 'valibot';

const untrustedInputSchema = v.unknown();
const errorInstanceSchema = v.instance(Error);
const errorWithCodeSchema = v.object({ code: v.unknown() });

type UntrustedInput = v.InferInput<typeof untrustedInputSchema>;
