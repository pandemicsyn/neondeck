import * as v from 'valibot';
import {
  verifiedGithubWebhookSchema,
  type VerifiedGithubWebhook,
} from './github-webhook';
import { jsonObjectSchema } from './json';
import { channelSchema } from './routes';

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
  deliveryId: v.pipe(v.string(), v.uuid()),
  event: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]{0,63}$/)),
  action: v.nullable(v.pipe(v.string(), v.minLength(1))),
  hookId: v.pipe(v.string(), v.regex(/^\d+$/)),
  receivedAt: v.pipe(v.string(), v.isoTimestamp()),
  repository: v.nullable(v.pipe(v.string(), v.minLength(1))),
  installationId: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
  payload: jsonObjectSchema,
});

export const clientControlFrameSchema = v.strictObject({
  version: protocolVersionSchema,
  type: v.literal('ping'),
});

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
  deliveryId: v.pipe(v.string(), v.uuid()),
  event: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]{0,63}$/)),
  action: v.nullable(v.pipe(v.string(), v.minLength(1))),
  repository: v.nullable(v.pipe(v.string(), v.minLength(1))),
  prNumber: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
  receivedAt: v.pipe(v.string(), v.isoTimestamp()),
});

// Sent as the first frame of a replay when `since` was supplied but could
// not be resolved (unknown or already-pruned delivery ID). No rows are
// replayed; the client must treat this as a gap and force a full refresh.
export const replayTruncatedFrameSchema = v.strictObject({
  version: protocolVersionSchema,
  type: v.literal('replay.truncated'),
});

export const serverFrameSchema = v.union([
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

export const pingFrameText = JSON.stringify(
  v.parse(clientControlFrameSchema, { version: 1, type: 'ping' }),
);

export const pongFrameText = JSON.stringify(
  v.parse(serverControlFrameSchema, { version: 1, type: 'pong' }),
);

export function createGithubWebhookEnvelope(
  channel: string,
  webhook: VerifiedGithubWebhook,
): GithubWebhookEnvelope {
  const parsedInput = v.parse(relayBroadcastInputSchema, { channel, webhook });
  return v.parse(githubWebhookEnvelopeSchema, {
    version: 1,
    type: 'github.webhook',
    channel: parsedInput.channel,
    deliveryId: parsedInput.webhook.deliveryId,
    event: parsedInput.webhook.event,
    action: parsedInput.webhook.payload.action ?? null,
    hookId: parsedInput.webhook.hookId,
    receivedAt: parsedInput.webhook.receivedAt,
    repository: parsedInput.webhook.payload.repository?.full_name ?? null,
    installationId: parsedInput.webhook.payload.installation?.id ?? null,
    payload: parsedInput.webhook.payload,
  });
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

export function encodeServerFrame(input: unknown): string {
  return JSON.stringify(v.parse(serverFrameSchema, input));
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
