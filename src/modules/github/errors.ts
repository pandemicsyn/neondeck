import * as v from 'valibot';

const githubErrorDetailSchema = v.looseObject({ message: v.string() });

export class GitHubApiError<TData> extends Error {
  constructor(
    readonly status: number,
    readonly data: TData,
    message: string,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

export function githubErrorMessage<TData>(response: Response, data?: TData) {
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

export function errorMessage<TError>(error: TError) {
  return error instanceof Error ? error.message : String(error);
}

export function isGitHubChecksAccessError<TError>(error: TError) {
  if (!(error instanceof GitHubApiError) || error.status !== 403) return false;
  const detail = githubResponseDetail(error.data)?.toLowerCase();
  return (
    detail === 'resource not accessible by personal access token' ||
    detail === 'resource not accessible by integration'
  );
}

export function isRequestTimeout<TError>(error: TError) {
  return (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  );
}

function githubResponseDetail<TData>(data: TData) {
  const parsed = v.safeParse(githubErrorDetailSchema, data);
  return parsed.success ? parsed.output.message : null;
}
