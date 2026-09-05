import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import * as v from 'valibot';
import { runtimePaths, type RuntimePaths } from '../runtime-home';
import {
  readyConnection,
  connectionFingerprint,
} from '../modules/factory/github-config';
import {
  acceptGitHubDelivery,
  githubDigest,
} from '../modules/factory/github-store';
import { githubCommentSchema } from '../../shared/factory-github';
import { FactoryError } from '../modules/factory/service';
export const githubWebhookMaxBytes = 1024 * 1024;
const payloadSchema = v.object({
  action: v.string(),
  repository: v.object({
    id: v.pipe(v.number(), v.integer(), v.minValue(1)),
    name: v.string(),
    owner: v.object({ login: v.string() }),
  }),
  issue: v.object({
    id: v.pipe(v.number(), v.integer(), v.minValue(1)),
    number: v.pipe(v.number(), v.integer(), v.minValue(1)),
    pull_request: v.optional(v.unknown()),
  }),
});
export async function boundedRequestBytes(
  request: Request,
  maxBytes: number,
  timeoutMs = 5000,
) {
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes))
    throw new Error('size');
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
  });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next.done) return Buffer.concat(chunks, total);
      total += next.value.byteLength;
      if (total > maxBytes) throw new Error('size');
      chunks.push(next.value);
    }
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
  }
}
/** Deliberately has no private application import, model dispatch, static fallback or provider fetch. */
export function createGitHubIngress(paths: RuntimePaths = runtimePaths()) {
  const app = new Hono();
  app.get('/health', (c) => c.json({ ok: true }));
  app.post('/hooks/github/:connectionId', async (c) => {
    try {
      const connection = readyConnection(c.req.param('connectionId'), paths);
      const signature = c.req.header('x-hub-signature-256') ?? '';
      if (!/^sha256=[a-f0-9]{64}$/.test(signature))
        return c.json({ error: 'Invalid signature.' }, 401);
      let bytes: Buffer;
      try {
        bytes = await boundedRequestBytes(c.req.raw, githubWebhookMaxBytes);
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
      if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex')))
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
      const event = c.req.header('x-github-event') ?? '';
      const actions =
        event === 'issues'
          ? [
              'opened',
              'edited',
              'closed',
              'reopened',
              'labeled',
              'unlabeled',
              'deleted',
              'transferred',
            ]
          : event === 'issue_comment'
            ? ['created', 'edited', 'deleted']
            : [];
      if (event === 'issue_comment') {
        const check = v.safeParse(
          v.object({ comment: githubCommentSchema }),
          JSON.parse(bytes.toString('utf8')),
        );
        if (!check.success)
          return c.json({ error: 'Invalid comment payload.' }, 400);
      }
      if (
        !actions.includes(payload.action) ||
        payload.issue.pull_request !== undefined
      )
        return c.json({ error: 'Unsupported issue event.' }, 422);
      if (
        String(payload.repository.id) !== connection.repositoryId ||
        payload.repository.owner.login.toLowerCase() !==
          connection.owner.toLowerCase() ||
        payload.repository.name.toLowerCase() !== connection.name.toLowerCase()
      )
        return c.json({ error: 'Repository binding mismatch.' }, 403);
      const deliveryId = c.req.header('x-github-delivery') ?? '';
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(deliveryId))
        return c.json({ error: 'Missing or invalid delivery ID.' }, 400);
      // Recheck after the asynchronous byte read. A configuration edit cannot admit stale mapping.
      if (
        connectionFingerprint(readyConnection(connection.id, paths)) !==
        connectionFingerprint(connection)
      )
        return c.json({ error: 'Connection changed.' }, 409);
      const result = acceptGitHubDelivery(
        {
          id: githubDigest([connection.id, deliveryId]),
          connectionId: connection.id,
          connectionFingerprint: connectionFingerprint(connection),
          repositoryId: connection.repositoryId,
          issueNumber: payload.issue.number,
          issueId: String(payload.issue.id),
          event,
          action: payload.action,
          digest: createHash('sha256').update(bytes).digest('hex'),
          state: 'pending',
          error: null,
          attempts: 0,
          retryAt: 0,
          createdAt: new Date().toISOString(),
        },
        paths,
      );
      return c.json({ accepted: true, ...result }, 202);
    } catch (error) {
      if (error instanceof FactoryError)
        return c.json({ error: error.message }, error.status);
      return c.json({ error: 'Delivery could not be persisted.' }, 503);
    }
  });
  return app;
}
