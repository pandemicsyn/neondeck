import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { verifyGithubSignature } from '../src/github-webhook';
import { fetchWorker, githubWebhookSecret, sendGithubWebhook } from './helpers';

const errorSchema = v.object({
  error: v.pipe(v.string(), v.minLength(1)),
  code: v.pipe(v.string(), v.minLength(1)),
});

const relayResponseSchema = v.object({
  relayed: v.literal(true),
  protocolVersion: v.literal(1),
  deliveryId: v.pipe(v.string(), v.uuid()),
  deliveredClients: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

describe('GitHub webhook ingress', () => {
  it('matches GitHub’s published HMAC-SHA256 test vector', async () => {
    const body = new TextEncoder().encode('Hello, World!');
    const signature =
      'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';

    await expect(
      verifyGithubSignature(body, signature, githubWebhookSecret),
    ).resolves.toBe(true);
  });

  it('returns the validated health response', async () => {
    const response = await fetchWorker(
      new Request('https://relay.test/healthz'),
    );

    expect(response.status).toBe(200);
    expect(
      v.parse(
        v.object({
          ok: v.literal(true),
          service: v.literal('github-webhook-relay'),
        }),
        await response.json(),
      ),
    ).toEqual({ ok: true, service: 'github-webhook-relay' });
  });

  it('verifies and relays the untouched Unicode JSON body', async () => {
    const deliveryId = '920e6ce4-c980-42d7-8292-6c2e08ab42ee';
    const response = await sendGithubWebhook({
      deliveryId,
      payload: {
        action: 'created',
        message: 'こんにちは 🌈',
        repository: { full_name: 'owner/repository' },
      },
    });

    expect(response.status).toBe(200);
    expect(v.parse(relayResponseSchema, await response.json())).toEqual({
      relayed: true,
      protocolVersion: 1,
      deliveryId,
      deliveredClients: 0,
    });
  });

  it('rejects an invalid signature without decoding the payload', async () => {
    const response = await sendGithubWebhook({
      body: 'not-json',
      signature: `sha256=${'0'.repeat(64)}`,
    });

    expect(response.status).toBe(401);
    expect(v.parse(errorSchema, await response.json()).code).toBe(
      'unauthorized',
    );
  });

  it('rejects missing required GitHub headers', async () => {
    const response = await sendGithubWebhook({
      omitHeaders: ['x-github-hook-id'],
    });

    expect(response.status).toBe(400);
    expect(v.parse(errorSchema, await response.json()).code).toBe(
      'invalid_request',
    );
  });

  it('rejects signed invalid JSON', async () => {
    const response = await sendGithubWebhook({ body: 'not-json' });

    expect(response.status).toBe(400);
    expect(v.parse(errorSchema, await response.json()).error).toContain(
      'not valid JSON',
    );
  });

  it('rejects a declared body length that does not match the stream', async () => {
    const body = JSON.stringify({ action: 'opened' });
    const response = await sendGithubWebhook({
      body,
      declaredLength: new TextEncoder().encode(body).byteLength + 1,
    });

    expect(response.status).toBe(400);
    expect(v.parse(errorSchema, await response.json()).error).toContain(
      'Content-Length',
    );
  });

  it('rejects a declared body larger than the deployment limit', async () => {
    const response = await sendGithubWebhook({ declaredLength: 1_048_577 });

    expect(response.status).toBe(413);
    expect(v.parse(errorSchema, await response.json()).code).toBe(
      'payload_too_large',
    );
  });

  it('returns 405 before consuming a webhook on the wrong method', async () => {
    const response = await sendGithubWebhook({ method: 'PUT' });

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('verifies a body signed with the previous secret during rotation', async () => {
    const response = await sendGithubWebhook({
      secret: 'A Previous Secret, Rotated Out',
    });

    expect(response.status).toBe(200);
    expect(v.parse(relayResponseSchema, await response.json()).relayed).toBe(
      true,
    );
  });

  it('rejects a body signed with a secret unrelated to either configured secret', async () => {
    const response = await sendGithubWebhook({
      secret: 'A Completely Unrelated Secret Value',
    });

    expect(response.status).toBe(401);
    expect(v.parse(errorSchema, await response.json()).code).toBe(
      'unauthorized',
    );
  });

  it('accepts GitHub redelivery with the same delivery ID', async () => {
    const deliveryId = '146b6c3d-fb13-46f7-a019-68f5ecf3c454';
    const first = await sendGithubWebhook({ deliveryId });
    const second = await sendGithubWebhook({ deliveryId });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(v.parse(relayResponseSchema, await first.json()).deliveryId).toBe(
      deliveryId,
    );
    expect(v.parse(relayResponseSchema, await second.json()).deliveryId).toBe(
      deliveryId,
    );
  });
});
