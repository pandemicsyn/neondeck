export function githubErrorMessage(response: Response) {
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

  return `GitHub request failed with ${response.status}`;
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
