export class WorktreeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'WorktreeError';
    this.code = code;
  }
}

export function failureResult(action: string, error: unknown) {
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

export function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isSqliteUniqueConstraint(error: unknown) {
  return (
    error instanceof Error &&
    ('code' in error
      ? String((error as { code?: unknown }).code).includes('CONSTRAINT')
      : /constraint/i.test(error.message))
  );
}
