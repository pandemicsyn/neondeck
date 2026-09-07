import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import * as v from 'valibot';
import { runtimePaths, type RuntimePaths } from '../runtime-home';
import {
  readyLinearConnection,
  linearFingerprint,
} from '../modules/factory/linear-config';
import { linearSourceFingerprint } from '../modules/factory/linear-authority';
import { acceptLinearDelivery } from '../modules/factory/linear-store';
import { FactoryError } from '../modules/factory/service';
import { boundedRequestBytes } from './github-ingress';
export const linearWebhookMaxBytes = 1024 * 1024;
const payloadSchema = v.object({
  action: v.picklist(['create', 'update', 'remove']),
  type: v.literal('Issue'),
  organizationId: v.pipe(v.string(), v.minLength(1), v.maxLength(240)),
  webhookTimestamp: v.pipe(v.number(), v.integer()),
  createdAt: v.pipe(v.string(), v.isoTimestamp()),
  data: v.object({ id: v.pipe(v.string(), v.minLength(1), v.maxLength(240)) }),
});
/** Signed facts are durably queued; request handling never fetches providers or invokes models. */
export function createLinearIngress(paths: RuntimePaths = runtimePaths()) {
  const app = new Hono();
  app.post('/hooks/linear/:connectionId', async (c) => {
    try {
      const connection = readyLinearConnection(
        c.req.param('connectionId'),
        paths,
      );
      const signature = c.req.header('linear-signature') ?? '';
      if (!/^[a-f0-9]{64}$/.test(signature))
        return c.json({ error: 'Invalid signature.' }, 401);
      let bytes: Buffer;
      try {
        bytes = await boundedRequestBytes(
          c.req.raw,
          linearWebhookMaxBytes,
          4000,
        );
      } catch (error) {
        return c.json(
          { error: 'Webhook body exceeds size or read deadline.' },
          error instanceof Error && error.message === 'timeout' ? 408 : 413,
        );
      }
      const expected = createHmac(
        'sha256',
        process.env[connection.webhookSecretEnv]!,
      )
        .update(bytes)
        .digest();
      if (!timingSafeEqual(expected, Buffer.from(signature, 'hex')))
        return c.json({ error: 'Invalid signature.' }, 401);
      let payload: v.InferOutput<typeof payloadSchema>;
      try {
        payload = v.parse(
          payloadSchema,
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
        );
      } catch {
        return c.json({ error: 'Invalid webhook payload.' }, 400);
      }
      if (Math.abs(Date.now() - payload.webhookTimestamp) > 60000)
        return c.json({ error: 'Webhook timestamp expired.' }, 401);
      if (payload.organizationId !== connection.organizationId)
        return c.json({ error: 'Organization binding mismatch.' }, 403);
      if (c.req.header('linear-event') !== payload.type)
        return c.json({ error: 'Event type mismatch.' }, 400);
      const deliveryId = c.req.header('linear-delivery') ?? '';
      if (
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
          deliveryId,
        )
      )
        return c.json({ error: 'Invalid delivery ID.' }, 400);
      if (
        linearSourceFingerprint(readyLinearConnection(connection.id, paths)) !==
        linearSourceFingerprint(connection)
      )
        return c.json({ error: 'Connection changed.' }, 409);
      const result = acceptLinearDelivery(
        {
          id: linearFingerprint([connection.id, deliveryId.toLowerCase()]),
          connectionId: connection.id,
          connectionFingerprint: linearFingerprint(connection),
          sourceFingerprint: linearSourceFingerprint(connection),
          issueId: payload.data.id,
          action: payload.action,
          digest: createHash('sha256').update(bytes).digest('hex'),
          createdAt: payload.createdAt,
        },
        paths,
      );
      return c.json(result, 200);
    } catch (error) {
      if (error instanceof FactoryError)
        return c.json({ error: error.message }, error.status);
      return c.json({ error: 'Delivery could not be persisted.' }, 503);
    }
  });
  return app;
}
