import { z } from 'zod';
import {
  verifiedGithubWebhookSchema,
  type VerifiedGithubWebhook,
} from './github-webhook';
import { jsonObjectSchema } from './json';
import { channelSchema } from './routes';

const maximumClientFrameCharacters = 256;

export const protocolVersionSchema = z.literal(1);

export const relayBroadcastInputSchema = z
  .object({
    channel: channelSchema,
    webhook: verifiedGithubWebhookSchema,
  })
  .strict();

export const githubWebhookEnvelopeSchema = z
  .object({
    version: protocolVersionSchema,
    type: z.literal('github.webhook'),
    channel: channelSchema,
    deliveryId: z.string().uuid(),
    event: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    action: z.string().min(1).nullable(),
    hookId: z.string().regex(/^\d+$/),
    receivedAt: z.string().datetime(),
    repository: z.string().min(1).nullable(),
    installationId: z.number().int().positive().nullable(),
    payload: jsonObjectSchema,
  })
  .strict();

export const clientControlFrameSchema = z
  .object({
    version: protocolVersionSchema,
    type: z.literal('ping'),
  })
  .strict();

export const serverControlFrameSchema = z
  .object({
    version: protocolVersionSchema,
    type: z.literal('pong'),
  })
  .strict();

export const serverFrameSchema = z.union([
  githubWebhookEnvelopeSchema,
  serverControlFrameSchema,
]);

export type GithubWebhookEnvelope = z.infer<typeof githubWebhookEnvelopeSchema>;

export const pingFrameText = JSON.stringify(
  clientControlFrameSchema.parse({ version: 1, type: 'ping' }),
);

export const pongFrameText = JSON.stringify(
  serverControlFrameSchema.parse({ version: 1, type: 'pong' }),
);

export function createGithubWebhookEnvelope(
  channel: string,
  webhook: VerifiedGithubWebhook,
): GithubWebhookEnvelope {
  const parsedInput = relayBroadcastInputSchema.parse({ channel, webhook });
  return githubWebhookEnvelopeSchema.parse({
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

export function encodeServerFrame(input: unknown): string {
  return JSON.stringify(serverFrameSchema.parse(input));
}

export function parseClientControlFrame(input: string) {
  const boundedInput = z
    .string()
    .max(maximumClientFrameCharacters)
    .safeParse(input);
  if (!boundedInput.success) {
    return { ok: false as const, reason: 'too_large' as const };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(boundedInput.data);
  } catch {
    return { ok: false as const, reason: 'invalid' as const };
  }
  const frame = clientControlFrameSchema.safeParse(decoded);
  return frame.success
    ? { ok: true as const, frame: frame.data }
    : { ok: false as const, reason: 'invalid' as const };
}
