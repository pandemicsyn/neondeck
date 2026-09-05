import { githubRetryAt } from './retry';

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    readonly data: unknown,
    message: string,
    readonly retry: { rateLimited: boolean; retryAt: number | null } = {
      rateLimited: status === 429,
      retryAt: null,
    },
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

export function githubErrorMessage(response: Response, data?: unknown) {
  const rateLimitRemaining = response.headers.get('x-ratelimit-remaining');

  if (
    response.status === 429 ||
    (response.status === 403 && rateLimitRemaining === '0')
  ) {
    const timestamp = githubRetryAt(response.headers);
    const retryAt =
      timestamp === null
        ? ''
        : ` Retry at ${new Date(timestamp).toISOString()}.`;
    return `GitHub request was rate limited with ${response.status}.${retryAt}`;
  }

  const detail = githubResponseDetail(data);
  return `GitHub request failed with ${response.status}${detail ? `: ${detail}` : ''}`;
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function isGitHubChecksAccessError(error: unknown) {
  if (!(error instanceof GitHubApiError) || error.status !== 403) return false;
  const detail = githubResponseDetail(error.data)?.toLowerCase();
  return (
    detail === 'resource not accessible by personal access token' ||
    detail === 'resource not accessible by integration'
  );
}

export function isRequestTimeout(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  );
}

function githubResponseDetail(data: unknown) {
  if (!data || typeof data !== 'object') return null;
  if ('message' in data && typeof data.message === 'string') {
    return data.message;
  }
  return null;
}
