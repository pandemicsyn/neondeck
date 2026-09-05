import * as v from 'valibot';

const timestampSchema = v.pipe(
  v.number(),
  v.safeInteger(),
  v.minValue(0),
  v.maxValue(8_640_000_000_000_000),
);

/** Untrusted provider timestamps never enter persistence without a finite bound. */
export function boundedGitHubRetryAt(value: unknown, now = Date.now()) {
  const parsed = v.safeParse(timestampSchema, value);
  return parsed.success && parsed.output >= now ? parsed.output : null;
}

/** Retry-After is delay-seconds (GitHub) or an HTTP-date (HTTP semantics).
 * Rate-limit reset is UTC epoch seconds, never a relative delay. Invalid or
 * non-representable values fall back to reset, then the caller's backoff.
 * Valid long delays are retained: never shorten a provider not-before time.
 */
export function githubRetryAt(headers: Headers, now = Date.now()) {
  const retry = headers.get('retry-after')?.trim();
  let retryAt: number | null = null;
  if (retry) {
    if (/^\d+$/.test(retry)) {
      retryAt = boundedGitHubRetryAt(now + Number(retry) * 1000, now);
    } else if (
      /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
        retry,
      )
    ) {
      const date = Date.parse(retry);
      // Date.parse alone accepts and normalizes some malformed calendar dates.
      if (Number.isFinite(date) && new Date(date).toUTCString() === retry)
        retryAt = boundedGitHubRetryAt(Math.max(now, date), now);
    }
  }
  if (retryAt !== null) return retryAt;
  const reset = headers.get('x-ratelimit-reset')?.trim();
  return reset && /^\d+$/.test(reset)
    ? boundedGitHubRetryAt(Number(reset) * 1000, now)
    : null;
}

export function githubWritebackRetryAt(value: unknown, now = Date.now()) {
  return Math.max(now + 300_000, boundedGitHubRetryAt(value, now) ?? 0);
}
