import { expect, it } from 'vitest';
import { githubRetryAt, githubWritebackRetryAt } from './retry';
import { githubErrorMessage } from './errors';
const now = Date.parse('2026-09-05T12:00:00Z');
it('distinguishes delay seconds, HTTP dates and UTC epoch reset seconds', () => {
  expect(githubRetryAt(new Headers({ 'retry-after': '90' }), now)).toBe(
    now + 90_000,
  );
  expect(
    githubRetryAt(
      new Headers({ 'retry-after': 'Sat, 05 Sep 2026 12:02:00 GMT' }),
      now,
    ),
  ).toBe(now + 120_000);
  expect(
    githubRetryAt(
      new Headers({ 'x-ratelimit-reset': String((now + 60_000) / 1000) }),
      now,
    ),
  ).toBe(now + 60_000);
  expect(
    githubRetryAt(
      new Headers({ 'retry-after': 'Sat, 05 Sep 2026 11:00:00 GMT' }),
      now,
    ),
  ).toBe(now);
});
it.each([
  'Infinity',
  'NaN',
  '1e309',
  '9'.repeat(400),
  '-1',
  '1.5',
  '',
  'tomorrow',
  '8640000000001',
  '2026-09-05',
  'Mon, 31 Feb 2026 12:00:00 GMT',
])('rejects invalid Retry-After %s and uses valid reset fallback', (value) => {
  expect(githubRetryAt(new Headers({ 'retry-after': value }), now)).toBeNull();
  expect(
    githubRetryAt(
      new Headers({
        'retry-after': value,
        'x-ratelimit-reset': String((now + 60_000) / 1000),
      }),
      now,
    ),
  ).toBe(now + 60_000);
});
it.each(['Infinity', 'NaN', '1e309', '9'.repeat(400), '-1', '1.5', '', '0'])(
  'rejects invalid reset %s without breaking error construction',
  (value) => {
    const headers = new Headers({ 'x-ratelimit-reset': value });
    expect(githubRetryAt(headers, now)).toBeNull();
    expect(() =>
      githubErrorMessage(new Response(null, { status: 429, headers })),
    ).not.toThrow();
  },
);
it.each([
  NaN,
  Infinity,
  -Infinity,
  null,
  undefined,
  '300',
  {},
  -1,
  8_640_000_000_000_001,
])('keeps writeback retry timestamps serializable for %s', (value) => {
  const result = githubWritebackRetryAt(value, now);
  expect(result).toBe(now + 300_000);
  expect(JSON.parse(JSON.stringify({ retryAt: result }))).toEqual({
    retryAt: result,
  });
});
it('honors a bounded longer writeback retry and keeps minimum backoff', () => {
  expect(githubWritebackRetryAt(now + 600_000, now)).toBe(now + 600_000);
  expect(githubWritebackRetryAt(now + 1, now)).toBe(now + 300_000);
});

it('honors long provider delays through writeback without shortening them', () => {
  const twoDays = now + 172_800_000;
  const headers = [
    new Headers({ 'retry-after': '172800' }),
    new Headers({ 'retry-after': new Date(twoDays).toUTCString() }),
    new Headers({ 'x-ratelimit-reset': String(twoDays / 1000) }),
  ];
  for (const header of headers) {
    const retryAt = githubRetryAt(header, now);
    expect(retryAt).toBe(twoDays);
    expect(githubWritebackRetryAt(retryAt, now)).toBe(twoDays);
  }
  expect(githubRetryAt(new Headers({ 'retry-after': '9999999999' }), now)).toBe(
    now + 9_999_999_999_000,
  );
});
it('accepts the Date timestamp limit and rejects finite values beyond it', () => {
  const limit = 8_640_000_000_000_000;
  expect(
    githubRetryAt(
      new Headers({ 'x-ratelimit-reset': String(limit / 1000) }),
      now,
    ),
  ).toBe(limit);
  expect(githubWritebackRetryAt(limit, now)).toBe(limit);
  expect(
    githubRetryAt(
      new Headers({ 'x-ratelimit-reset': String(limit / 1000 + 1) }),
      now,
    ),
  ).toBeNull();
});
