import { z } from 'zod';
import { jsonObjectSchema } from './json';

const maximumBufferedPayloadBytes = 5 * 1024 * 1024;

const webhookEnvironmentSchema = z.object({
  GITHUB_WEBHOOK_SECRET: z.string().min(16),
  MAX_WEBHOOK_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(maximumBufferedPayloadBytes),
});

const contentLengthSchema = z
  .string()
  .regex(/^\d+$/)
  .transform((value) => Number(value));

const githubHeadersSchema = z.object({
  contentLength: contentLengthSchema,
  contentType: z.string().regex(/^application\/json(?:\s*;.*)?$/i),
  deliveryId: z.string().uuid(),
  event: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  hookId: z.string().regex(/^\d+$/),
  signature: z.string().regex(/^sha256=[0-9a-f]{64}$/),
});

const signatureVerificationInputSchema = z.object({
  body: z.instanceof(Uint8Array),
  signatureHeader: z.string().regex(/^sha256=[0-9a-f]{64}$/),
  secret: z.string().min(16),
});

export const githubPayloadSchema = z
  .object({
    action: z.string().min(1).optional(),
    installation: z
      .object({ id: z.number().int().positive() })
      .passthrough()
      .optional(),
    repository: z
      .object({ full_name: z.string().min(1) })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .superRefine((value, context) => {
    if (!jsonObjectSchema.safeParse(value).success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'GitHub payload must be a finite, acyclic JSON object.',
      });
    }
  });

export const verifiedGithubWebhookSchema = z
  .object({
    deliveryId: z.string().uuid(),
    event: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    hookId: z.string().regex(/^\d+$/),
    receivedAt: z.string().datetime(),
    payload: githubPayloadSchema,
  })
  .strict();

export type VerifiedGithubWebhook = z.infer<typeof verifiedGithubWebhookSchema>;

export type GithubWebhookFailure = {
  ok: false;
  status: 400 | 401 | 413 | 500;
  code: 'invalid_request' | 'payload_too_large' | 'unauthorized';
  error: string;
};

export type GithubWebhookResult =
  { ok: true; webhook: VerifiedGithubWebhook } | GithubWebhookFailure;

export async function verifyGithubWebhook(
  request: Request,
  env: Env,
): Promise<GithubWebhookResult> {
  const parsedEnvironment = webhookEnvironmentSchema.safeParse(env);
  if (!parsedEnvironment.success) {
    return failure(500, 'invalid_request', 'Webhook configuration is invalid.');
  }

  const parsedHeaders = githubHeadersSchema.safeParse({
    contentLength: request.headers.get('content-length'),
    contentType: request.headers.get('content-type'),
    deliveryId: request.headers.get('x-github-delivery'),
    event: request.headers.get('x-github-event'),
    hookId: request.headers.get('x-github-hook-id'),
    signature: request.headers.get('x-hub-signature-256'),
  });
  if (!parsedHeaders.success) {
    return failure(
      400,
      'invalid_request',
      'GitHub webhook headers are invalid.',
    );
  }

  if (
    parsedHeaders.data.contentLength > parsedEnvironment.data.MAX_WEBHOOK_BYTES
  ) {
    return failure(413, 'payload_too_large', 'Webhook payload is too large.');
  }

  const body = await readBodyWithLimit(
    request.body,
    parsedHeaders.data.contentLength,
    parsedEnvironment.data.MAX_WEBHOOK_BYTES,
  );
  if (!body.ok) return body;

  const signatureValid = await verifyGithubSignature(
    body.bytes,
    parsedHeaders.data.signature,
    parsedEnvironment.data.GITHUB_WEBHOOK_SECRET,
  );
  if (!signatureValid) {
    return failure(401, 'unauthorized', 'Webhook signature is invalid.');
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
        body.bytes,
      ),
    );
  } catch {
    return failure(
      400,
      'invalid_request',
      'Webhook payload is not valid JSON.',
    );
  }

  const parsedPayload = githubPayloadSchema.safeParse(decoded);
  if (!parsedPayload.success) {
    return failure(
      400,
      'invalid_request',
      'GitHub webhook payload is invalid.',
    );
  }

  return {
    ok: true,
    webhook: verifiedGithubWebhookSchema.parse({
      deliveryId: parsedHeaders.data.deliveryId,
      event: parsedHeaders.data.event,
      hookId: parsedHeaders.data.hookId,
      receivedAt: new Date().toISOString(),
      payload: parsedPayload.data,
    }),
  };
}

async function readBodyWithLimit(
  body: ReadableStream<Uint8Array> | null,
  contentLength: number,
  limit: number,
): Promise<{ ok: true; bytes: Uint8Array } | GithubWebhookFailure> {
  if (!body) {
    return failure(400, 'invalid_request', 'Webhook payload is required.');
  }

  const reader = body.getReader();
  const bytes = new Uint8Array(contentLength);
  let total = 0;

  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;

      const nextTotal = total + next.value.byteLength;
      if (nextTotal > limit) {
        await reader.cancel('payload too large');
        return failure(
          413,
          'payload_too_large',
          'Webhook payload is too large.',
        );
      }
      if (nextTotal > contentLength) {
        await reader.cancel('content length mismatch');
        return failure(
          400,
          'invalid_request',
          'Webhook payload does not match Content-Length.',
        );
      }
      bytes.set(next.value, total);
      total = nextTotal;
    }
  } finally {
    reader.releaseLock();
  }

  if (total !== contentLength) {
    return failure(
      400,
      'invalid_request',
      'Webhook payload does not match Content-Length.',
    );
  }
  return { ok: true, bytes };
}

export async function verifyGithubSignature(
  body: Uint8Array,
  signatureHeader: string,
  secret: string,
): Promise<boolean> {
  const input = signatureVerificationInputSchema.parse({
    body,
    signatureHeader,
    secret,
  });
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(input.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    'HMAC',
    key,
    hexToBytes(input.signatureHeader.slice('sha256='.length)),
    input.body,
  );
}

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

function failure(
  status: GithubWebhookFailure['status'],
  code: GithubWebhookFailure['code'],
  error: string,
): GithubWebhookFailure {
  return { ok: false, status, code, error };
}
