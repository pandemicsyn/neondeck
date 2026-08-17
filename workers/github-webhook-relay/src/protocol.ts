import * as v from 'valibot';
import {
  verifiedGithubWebhookSchema,
  type VerifiedGithubWebhook,
} from './github-webhook';
import { jsonObjectSchema, type JsonObject } from './json';
import { channelSchema } from './routes';
import {
  githubDeliveryIdSchema,
  githubEventNameSchema,
  githubHookIdSchema,
  isoTimestampSchema,
  nullableNonEmptyStringSchema,
  positiveIntegerSchema,
} from './schema-primitives';

const maximumClientFrameCharacters = 256;

export const protocolVersionSchema = v.literal(1);

export const relayBroadcastInputSchema = v.strictObject({
  channel: channelSchema,
  webhook: verifiedGithubWebhookSchema,
});

export const githubWebhookEnvelopeSchema = v.strictObject({
  version: protocolVersionSchema,
  type: v.literal('github.webhook'),
  channel: channelSchema,
  deliveryId: githubDeliveryIdSchema,
  event: githubEventNameSchema,
  action: nullableNonEmptyStringSchema,
  hookId: githubHookIdSchema,
  receivedAt: isoTimestampSchema,
  repository: nullableNonEmptyStringSchema,
  installationId: v.nullable(positiveIntegerSchema),
  prNumber: v.nullable(positiveIntegerSchema),
  payload: jsonObjectSchema,
});

// Field declaration order on these two control-frame schemas is part of the
// wire contract, not an implementation detail: `pingFrameText` /
// `pongFrameText` below are `JSON.stringify(v.parse(...))`, and
// `JSON.stringify` serializes object keys in insertion order. `RelayRoom`'s
// `setWebSocketAutoResponse` matches the canonical ping byte-for-byte
// against what a client sends, and PROTOCOL.md documents that byte string
// literally as `{"version":1,"type":"ping"}`. Reordering these fields
// changes `pingFrameText`'s bytes, silently breaking every external
// client's keepalive match — it would fall through to `webSocketMessage`
// and wake the Durable Object on every ping, reintroducing the continuous
// duration billing this relay's hibernation design exists to avoid. Add
// fields at the end, never reorder existing ones.
export const clientControlFrameSchema = v.strictObject({
  version: protocolVersionSchema,
  type: v.literal('ping'),
});

// See the field-order note on `clientControlFrameSchema` above — it applies
// equally here for `pongFrameText`.
export const serverControlFrameSchema = v.strictObject({
  version: protocolVersionSchema,
  type: v.literal('pong'),
});

// A replayed event log row. It deliberately carries only the routing facts
// that were persisted — never the GitHub payload, which the relay does not
// store at rest. Consumers that need the payload re-fetch from GitHub.
export const githubWebhookReplayEnvelopeSchema = v.strictObject({
  version: protocolVersionSchema,
  type: v.literal('github.webhook.replay'),
  channel: channelSchema,
  deliveryId: githubDeliveryIdSchema,
  event: githubEventNameSchema,
  action: nullableNonEmptyStringSchema,
  repository: nullableNonEmptyStringSchema,
  prNumber: v.nullable(positiveIntegerSchema),
  receivedAt: isoTimestampSchema,
});

// Sent as the first frame of a replay when `since` was supplied but could
// not be resolved (unknown or already-pruned delivery ID). No rows are
// replayed; the client must treat this as a gap and force a full refresh.
export const replayTruncatedFrameSchema = v.strictObject({
  version: protocolVersionSchema,
  type: v.literal('replay.truncated'),
});

// A `type`-discriminated union: `v.variant` is the idiomatic valibot tool
// for this shape (each member is a strict object with a literal `type`),
// and it short-circuits to the matching member on the discriminator instead
// of trying every union member in order.
export const serverFrameSchema = v.variant('type', [
  githubWebhookEnvelopeSchema,
  githubWebhookReplayEnvelopeSchema,
  replayTruncatedFrameSchema,
  serverControlFrameSchema,
]);

export type GithubWebhookEnvelope = v.InferOutput<
  typeof githubWebhookEnvelopeSchema
>;
export type GithubWebhookReplayEnvelope = v.InferOutput<
  typeof githubWebhookReplayEnvelopeSchema
>;
export type ServerFrame = v.InferOutput<typeof serverFrameSchema>;

export const pingFrameText = JSON.stringify(
  v.parse(clientControlFrameSchema, { version: 1, type: 'ping' }),
);

export const pongFrameText = JSON.stringify(
  v.parse(serverControlFrameSchema, { version: 1, type: 'pong' }),
);

// Pulls a PR number out of an already-signature-verified but otherwise
// untyped GitHub payload. This is real GitHub input — the payload's nested
// shape is not guaranteed by any type, so it is validated here. Shared by
// both the live envelope (`createGithubWebhookEnvelope`) and the persisted
// event log row (`RelayRoom.recordEvent`) so there is exactly one
// implementation of the derivation.
const prNumberSourceSchema = v.looseObject({
  pull_request: v.optional(v.looseObject({ number: positiveIntegerSchema })),
  issue: v.optional(v.looseObject({ number: positiveIntegerSchema })),
});

export function extractPrNumber(payload: unknown): number | null {
  const parsed = v.safeParse(prNumberSourceSchema, payload);
  if (!parsed.success) return null;
  return (
    parsed.output.pull_request?.number ?? parsed.output.issue?.number ?? null
  );
}

// `channel` and `webhook` are already fully validated by the time either
// caller reaches this function — `channel` from `channelSchema` at the
// route or Durable Object identity boundary, `webhook` from
// `relayBroadcastInputSchema` at the RPC boundary in `RelayRoom.broadcast`.
// Re-running `v.parse` here would re-walk `webhook.payload`, which is GitHub
// data up to 5 MB, for no new information. Construct the envelope as a
// typed literal instead; the `GithubWebhookEnvelope` return type still
// holds the compiler to the wire shape.
export function createGithubWebhookEnvelope(
  channel: string,
  webhook: VerifiedGithubWebhook,
): GithubWebhookEnvelope {
  return {
    version: 1,
    type: 'github.webhook',
    channel,
    deliveryId: webhook.deliveryId,
    event: webhook.event,
    action: webhook.payload.action ?? null,
    hookId: webhook.hookId,
    receivedAt: webhook.receivedAt,
    repository: webhook.payload.repository?.full_name ?? null,
    installationId: webhook.payload.installation?.id ?? null,
    prNumber: extractPrNumber(webhook.payload),
    // `githubPayloadSchema` (see github-webhook.ts) already runtime-checks
    // this value against the same `v.check` that backs `jsonObjectSchema`,
    // so it genuinely is a `JsonObject` — but `v.looseObject`'s inferred
    // type carries an `[key: string]: unknown` index signature that
    // doesn't statically narrow to `JsonValue`. The assertion documents
    // that gap instead of paying for a second walk of a payload already
    // proven finite and acyclic.
    payload: webhook.payload as JsonObject,
  };
}

// Row shape read back from the Durable Object's persisted event log.
export type EventLogRow = {
  deliveryId: string;
  event: string;
  action: string | null;
  repository: string | null;
  prNumber: number | null;
  receivedAt: string;
};

// `row` is read back from this Durable Object's own SQLite storage, written
// only by `recordEvent` from already-validated fields — not an external
// trust boundary — but `channel` is re-validated because `replayFrom`'s
// caller passes it as a plain `string` at a call site further from the
// route parse than the live-broadcast path above.
export function createGithubWebhookReplayEnvelope(
  channel: string,
  row: EventLogRow,
): GithubWebhookReplayEnvelope {
  return v.parse(githubWebhookReplayEnvelopeSchema, {
    version: 1,
    type: 'github.webhook.replay',
    channel: v.parse(channelSchema, channel),
    deliveryId: row.deliveryId,
    event: row.event,
    action: row.action,
    repository: row.repository,
    prNumber: row.prNumber,
    receivedAt: row.receivedAt,
  });
}

export function encodeServerFrame(frame: ServerFrame): string {
  return JSON.stringify(frame);
}

export function parseClientControlFrame(input: string) {
  const boundedInput = v.safeParse(
    v.pipe(v.string(), v.maxLength(maximumClientFrameCharacters)),
    input,
  );
  if (!boundedInput.success) {
    return { ok: false as const, reason: 'too_large' as const };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(boundedInput.output);
  } catch {
    return { ok: false as const, reason: 'invalid' as const };
  }
  const frame = v.safeParse(clientControlFrameSchema, decoded);
  return frame.success
    ? { ok: true as const, frame: frame.output }
    : { ok: false as const, reason: 'invalid' as const };
}
