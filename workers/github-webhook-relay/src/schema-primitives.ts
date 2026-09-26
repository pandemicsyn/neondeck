// Shared valibot building blocks. Each primitive here was duplicated across
// three or more schemas before this module existed — see
// `.plans/GITHUB_WEBHOOK_RELAY_PLAN.md` review notes. Keep primitives here
// only when the *shape* is genuinely identical; a coincidental match on a
// single field is not enough to warrant sharing.
import * as v from 'valibot';

// A generic RFC 4122 UUID. `githubDeliveryIdSchema` and a connection's
// `connectionId` both build on this — the shape is identical, but they are
// kept as distinct exports because they identify different things and may
// diverge (e.g. if GitHub ever changes its delivery ID format).
export const uuidSchema = v.pipe(v.string(), v.uuid());

export const githubDeliveryIdSchema = uuidSchema;

// GitHub's `X-GitHub-Event` header value, e.g. `pull_request`,
// `check_suite`.
export const githubEventNameSchema = v.pipe(
  v.string(),
  v.regex(/^[a-z][a-z0-9_]{0,63}$/),
);

// GitHub's `X-GitHub-Hook-ID` header value: a decimal integer carried as a
// string, never parsed to a number since it is only ever compared or
// forwarded, not computed on.
export const githubHookIdSchema = v.pipe(v.string(), v.regex(/^\d+$/));

export const isoTimestampSchema = v.pipe(v.string(), v.isoTimestamp());

export const positiveIntegerSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
);

export const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));

export const nullableNonEmptyStringSchema = v.nullable(nonEmptyStringSchema);
