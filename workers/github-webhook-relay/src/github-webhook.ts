import * as v from 'valibot';
import { jsonObjectSchema } from './json';

const maximumBufferedPayloadBytes = 5 * 1024 * 1024;

const webhookEnvironmentSchema = v.object({
  GITHUB_WEBHOOK_SECRET: v.pipe(v.string(), v.minLength(16)),
  // Optional. Set during rotation so a body signed with the outgoing secret
  // still verifies while GitHub is updated to the new one, removing the
  // signature-mismatch window a single secret guarantees.
  GITHUB_WEBHOOK_SECRET_PREVIOUS: v.optional(
    v.pipe(v.string(), v.minLength(16)),
  ),
  MAX_WEBHOOK_BYTES: v.pipe(
    v.unknown(),
    v.transform((value) => Number(value)),
    v.number(),
    v.integer(),
    v.minValue(1024),
    v.maxValue(maximumBufferedPayloadBytes),
  ),
});

const contentLengthSchema = v.pipe(
  v.string(),
  v.regex(/^\d+$/),
  v.transform((value) => Number(value)),
);

const githubHeadersSchema = v.object({
  contentLength: contentLengthSchema,
  contentType: v.pipe(v.string(), v.regex(/^application\/json(?:\s*;.*)?$/i)),
  deliveryId: v.pipe(v.string(), v.uuid()),
  event: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]{0,63}$/)),
  hookId: v.pipe(v.string(), v.regex(/^\d+$/)),
  signature: v.pipe(v.string(), v.regex(/^sha256=[0-9a-f]{64}$/)),
});

// Note: signature verification input used to be validated by its own schema
// here, but the inputs come only from `verifyGithubWebhook` below with
// already-checked types (Uint8Array body, a regex-matched signature header,
// and a length-checked secret) — an internal call, not a trust boundary.

export const githubPayloadSchema = v.pipe(
  v.looseObject({
    action: v.optional(v.pipe(v.string(), v.minLength(1))),
    installation: v.optional(
      v.looseObject({ id: v.pipe(v.number(), v.integer(), v.minValue(1)) }),
    ),
    repository: v.optional(
      v.looseObject({ full_name: v.pipe(v.string(), v.minLength(1)) }),
    ),
  }),
  v.check(
    (value) => v.safeParse(jsonObjectSchema, value).success,
    'GitHub payload must be a finite, acyclic JSON object.',
  ),
);

export const verifiedGithubWebhookSchema = v.strictObject({
  deliveryId: v.pipe(v.string(), v.uuid()),
  event: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]{0,63}$/)),
  hookId: v.pipe(v.string(), v.regex(/^\d+$/)),
  receivedAt: v.pipe(v.string(), v.isoTimestamp()),
  payload: githubPayloadSchema,
});

export type VerifiedGithubWebhook = v.InferOutput<
  typeof verifiedGithubWebhookSchema
>;

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
  const parsedEnvironment = v.safeParse(webhookEnvironmentSchema, env);
  if (!parsedEnvironment.success) {
    return failure(500, 'invalid_request', 'Webhook configuration is invalid.');
  }

  const parsedHeaders = v.safeParse(githubHeadersSchema, {
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
    parsedHeaders.output.contentLength >
    parsedEnvironment.output.MAX_WEBHOOK_BYTES
  ) {
    return failure(413, 'payload_too_large', 'Webhook payload is too large.');
  }

  const body = await readBodyWithLimit(
    request.body,
    parsedHeaders.output.contentLength,
    parsedEnvironment.output.MAX_WEBHOOK_BYTES,
  );
  if (!body.ok) return body;

  const candidateSecrets = [
    parsedEnvironment.output.GITHUB_WEBHOOK_SECRET,
    ...(parsedEnvironment.output.GITHUB_WEBHOOK_SECRET_PREVIOUS
      ? [parsedEnvironment.output.GITHUB_WEBHOOK_SECRET_PREVIOUS]
      : []),
  ];
  let signatureValid = false;
  for (const secret of candidateSecrets) {
    if (
      await verifyGithubSignature(
        body.bytes,
        parsedHeaders.output.signature,
        secret,
      )
    ) {
      signatureValid = true;
      break;
    }
  }
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

  const parsedPayload = v.safeParse(githubPayloadSchema, decoded);
  if (!parsedPayload.success) {
    return failure(
      400,
      'invalid_request',
      'GitHub webhook payload is invalid.',
    );
  }

  return {
    ok: true,
    webhook: v.parse(verifiedGithubWebhookSchema, {
      deliveryId: parsedHeaders.output.deliveryId,
      event: parsedHeaders.output.event,
      hookId: parsedHeaders.output.hookId,
      receivedAt: new Date().toISOString(),
      payload: parsedPayload.output,
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
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    'HMAC',
    key,
    hexToBytes(signatureHeader.slice('sha256='.length)),
    body,
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
