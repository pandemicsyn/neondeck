import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  fixture,
  issue,
  connection,
} from '../modules/factory/testing/github-fixture';
import { createGitHubIngress, githubWebhookMaxBytes } from './github-ingress';
import { factoryGitHubState } from '../modules/factory/github-reconcile';
let setup: ReturnType<typeof fixture>;
beforeEach(() => {
  setup = fixture();
});
afterEach(() => setup.dispose());
const payload = () => ({
  action: 'opened',
  repository: { id: 42, name: 'fixture', owner: { login: 'example' } },
  issue,
});
function request(
  body = JSON.stringify(payload()),
  headers: Record<string, string> = {},
) {
  return new Request('http://ingress.test/hooks/github/synthetic', {
    method: 'POST',
    body,
    headers: {
      'x-hub-signature-256': `sha256=${createHmac('sha256', process.env.FACTORY_TEST_WEBHOOK!).update(body).digest('hex')}`,
      'x-github-event': 'issues',
      'x-github-delivery': 'delivery-1',
      ...headers,
    },
  });
}
it('persists signed original UTF8 bytes before acknowledgement, replays once, rejects conflicting bytes', async () => {
  const app = createGitHubIngress(setup.paths);
  const body = JSON.stringify({ ...payload(), padding: 'é☃' });
  expect((await app.request(request(body))).status).toBe(202);
  expect(await (await app.request(request(body))).json()).toMatchObject({
    duplicate: true,
  });
  expect((await app.request(request())).status).toBe(409);
  const state = factoryGitHubState(setup.paths);
  expect(state.deliveries).toHaveLength(1);
  expect(state.deliveries[0].state).toBe('pending');
});
it.each(['', 'sha1=abc', 'sha256=abc', `sha256=${'0'.repeat(64)}`])(
  'rejects malformed or incorrect signature %s',
  async (signature) => {
    expect(
      (
        await createGitHubIngress(setup.paths).request(
          request(undefined, { 'x-hub-signature-256': signature }),
        )
      ).status,
    ).toBe(401);
    expect(factoryGitHubState(setup.paths).deliveries).toHaveLength(0);
  },
);
it('rejects signed wrong repositories, PR-shaped issues, irrelevant events and actions', async () => {
  const app = createGitHubIngress(setup.paths);
  expect(
    (
      await app.request(
        request(
          JSON.stringify({
            ...payload(),
            repository: { ...payload().repository, id: 43 },
          }),
        ),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await app.request(
        request(
          JSON.stringify({
            ...payload(),
            issue: { ...issue, pull_request: {} },
          }),
        ),
      )
    ).status,
  ).toBe(422);
  expect(
    (await app.request(request(undefined, { 'x-github-event': 'push' })))
      .status,
  ).toBe(422);
  expect(
    (
      await app.request(
        request(JSON.stringify({ ...payload(), action: 'assigned' })),
      )
    ).status,
  ).toBe(422);
});
it('bounds chunked bodies without Content-Length and leaves no receipt', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(githubWebhookMaxBytes));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    },
  });
  const req = new Request('http://ingress.test/hooks/github/synthetic', {
    method: 'POST',
    body: stream,
    duplex: 'half',
    headers: { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` },
  } as RequestInit);
  expect((await createGitHubIngress(setup.paths).request(req)).status).toBe(
    413,
  );
  expect(factoryGitHubState(setup.paths).deliveries).toHaveLength(0);
});
it('rejects disabled and ambiguous mapping independently of signature', async () => {
  setup.config([connection, { ...connection, id: 'other' }]);
  expect(
    (await createGitHubIngress(setup.paths).request(request())).status,
  ).toBe(409);
  setup.config([{ ...connection, enabled: false }]);
  expect(
    (await createGitHubIngress(setup.paths).request(request())).status,
  ).toBe(409);
});
it.each([
  '/api/factory/state',
  '/api/flue/agents/factory-planner/any',
  '/agents/any',
  '/reports/a',
  '/attachments/a',
  '/assets/app.js',
  '/',
  '/factory',
])(
  'never exposes private route %s with spoofed browser headers',
  async (path) => {
    const response = await createGitHubIngress(setup.paths).request(
      `http://ingress.test${path}`,
      { headers: { host: 'localhost', origin: 'http://localhost' } },
    );
    expect(response.status).toBe(404);
  },
);

it('rejects connection edits while the signed body is still arriving', async () => {
  const body = JSON.stringify(payload());
  const signature = `sha256=${createHmac('sha256', process.env.FACTORY_TEST_WEBHOOK!).update(body).digest('hex')}`;
  let send!: () => void;
  const stream = new ReadableStream({
    start(controller) {
      send = () => {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      };
    },
  });
  const pending = createGitHubIngress(setup.paths).request(
    new Request('http://ingress.test/hooks/github/synthetic', {
      method: 'POST',
      body: stream,
      duplex: 'half',
      headers: {
        'x-hub-signature-256': signature,
        'x-github-event': 'issues',
        'x-github-delivery': 'changing',
      },
    } as RequestInit),
  );
  await Promise.resolve();
  setup.config([{ ...connection, admission: { mode: 'all' } }]);
  send();
  expect((await pending).status).toBe(409);
  expect(factoryGitHubState(setup.paths).deliveries).toHaveLength(0);
});
