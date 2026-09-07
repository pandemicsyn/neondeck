import { createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fixture } from '../modules/factory/testing/github-fixture';
import { createLinearIngress, linearWebhookMaxBytes } from './linear-ingress';
import { createGitHubIngress } from './github-ingress';
import { acceptLinearDelivery } from '../modules/factory/linear-store';
import type { LinearConnection } from '../../shared/factory-linear';
vi.mock('../modules/factory/linear-store', () => ({
  acceptLinearDelivery: vi.fn(() => ({ duplicate: false })),
}));
let setup: ReturnType<typeof fixture>;
const connection: LinearConnection = {
  id: 'linear-test',
  enabled: true,
  organizationId: 'org',
  teamId: 'team',
  projectId: null,
  repoId: 'fixture',
  tokenEnv: 'FACTORY_TEST_TOKEN',
  webhookSecretEnv: 'FACTORY_TEST_WEBHOOK',
  admission: { mode: 'all' },
  writeback: { enabled: false, states: {} },
};
function config(enabled = true) {
  writeFileSync(
    setup.paths.config,
    JSON.stringify({
      version: 1,
      factory: { enabled: true, linear: [{ ...connection, enabled }] },
      models: { default: 'faux/faux-1' },
    }),
  );
}
beforeEach(() => {
  setup = fixture();
  config();
});
afterEach(() => {
  setup.dispose();
  vi.clearAllMocks();
});
const payload = () => ({
  action: 'update',
  type: 'Issue',
  organizationId: 'org',
  webhookTimestamp: Date.now(),
  createdAt: new Date().toISOString(),
  data: { id: 'issue' },
});
function request(
  body = JSON.stringify(payload()),
  headers: Record<string, string> = {},
) {
  return new Request('http://ingress.test/hooks/linear/linear-test', {
    method: 'POST',
    body,
    headers: {
      'linear-signature': createHmac(
        'sha256',
        process.env.FACTORY_TEST_WEBHOOK!,
      )
        .update(body)
        .digest('hex'),
      'linear-event': 'Issue',
      'linear-delivery': '234d1a4e-b617-4388-90fe-adc3633d6b72',
      ...headers,
    },
  });
}
it('authenticates original UTF8 bytes and durably queues before HTTP200', async () => {
  const response = await createLinearIngress(setup.paths).request(
    request(JSON.stringify({ ...payload(), title: 'é☃' })),
  );
  expect(response.status).toBe(200);
  expect(acceptLinearDelivery).toHaveBeenCalledWith(
    expect.objectContaining({
      connectionId: connection.id,
      issueId: 'issue',
      action: 'update',
      digest: expect.any(String),
    }),
    setup.paths,
  );
});
it.each(['', 'abc', '0'.repeat(64)])(
  'rejects invalid signatures %s',
  async (signature) => {
    expect(
      (
        await createLinearIngress(setup.paths).request(
          request(undefined, { 'linear-signature': signature }),
        )
      ).status,
    ).toBe(401);
    expect(acceptLinearDelivery).not.toHaveBeenCalled();
  },
);
it('requires signed current timestamps, organization and UUID delivery binding', async () => {
  const app = createLinearIngress(setup.paths);
  expect(
    (
      await app.request(
        request(
          JSON.stringify({
            ...payload(),
            webhookTimestamp: Date.now() - 61000,
          }),
        ),
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await app.request(
        request(JSON.stringify({ ...payload(), organizationId: 'wrong' })),
      )
    ).status,
  ).toBe(403);
  expect(
    (await app.request(request(undefined, { 'linear-delivery': 'bad' })))
      .status,
  ).toBe(400);
  expect(acceptLinearDelivery).not.toHaveBeenCalled();
});
it('rejects unsupported events, oversized body and disabled connections', async () => {
  const app = createLinearIngress(setup.paths);
  expect(
    (
      await app.request(
        request(JSON.stringify({ ...payload(), type: 'Comment' })),
      )
    ).status,
  ).toBe(400);
  expect(
    (await app.request(request('a'.repeat(linearWebhookMaxBytes + 1)))).status,
  ).toBe(413);
  config(false);
  expect((await app.request(request())).status).toBe(409);
  expect(acceptLinearDelivery).not.toHaveBeenCalled();
});
it('fences configuration changes during the asynchronous byte read', async () => {
  const body = JSON.stringify(payload());
  let send!: () => void;
  const stream = new ReadableStream({
    start(c) {
      send = () => {
        c.enqueue(new TextEncoder().encode(body));
        c.close();
      };
    },
  });
  const original = request(body);
  const pending = createLinearIngress(setup.paths).request(
    new Request(original.url, {
      method: 'POST',
      headers: original.headers,
      body: stream,
      duplex: 'half',
    } as RequestInit),
  );
  await Promise.resolve();
  config(false);
  send();
  expect((await pending).status).toBe(409);
  expect(acceptLinearDelivery).not.toHaveBeenCalled();
});
it('never exposes private routes', async () => {
  const app = createLinearIngress(setup.paths);
  for (const path of [
    '/',
    '/api/factory/state',
    '/api/flue/agents/factory-planner',
    '/assets/main.js',
  ])
    expect((await app.request(`http://ingress.test${path}`)).status).toBe(404);
});

it('mounts both public provider routes without exposing the private application', async () => {
  const app = createGitHubIngress(setup.paths).route(
    '/',
    createLinearIngress(setup.paths),
  );
  expect((await app.request(request())).status).toBe(200);
  expect((await app.request('http://ingress.test/health')).status).toBe(200);
  expect(
    (
      await app.request('http://ingress.test/hooks/github/synthetic', {
        method: 'POST',
      })
    ).status,
  ).toBe(404);
  expect(
    (await app.request('http://ingress.test/api/factory/state')).status,
  ).toBe(404);
});
