export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    readonly data: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

export function githubErrorMessage(response: Response, data?: unknown) {
  const rateLimitRemaining = response.headers.get('x-ratelimit-remaining');
  const rateLimitReset = response.headers.get('x-ratelimit-reset');
  const retryAfter = response.headers.get('retry-after');

  if (
    response.status === 429 ||
    (response.status === 403 && rateLimitRemaining === '0')
  ) {
    const retryAt = retryAfter
      ? ` Retry after ${retryAfter}s.`
      : rateLimitReset
        ? ` Rate limit resets at ${new Date(Number(rateLimitReset) * 1000).toISOString()}.`
        : '';
    return `GitHub request was rate limited with ${response.status}.${retryAt}`;
  }

  const detail = githubResponseDetail(data);
  return `GitHub request failed with ${response.status}${detail ? `: ${detail}` : ''}`;
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
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
