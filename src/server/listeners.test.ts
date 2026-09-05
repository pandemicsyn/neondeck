import { createServer } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  listenerConfig,
  startNeondeckListeners,
  type HostedApplication,
} from './listeners';
import { createGitHubIngress } from './github-ingress';
import { fixture } from '../modules/factory/testing/github-fixture';
const owned: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const cleanup of owned.reverse()) await cleanup();
  owned.length = 0;
});
async function port() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === 'string')
    throw new Error('Port allocation failed');
  return address.port;
}
it('only accepts loopback private binds and distinct configured ports', () => {
  expect(listenerConfig({})).toMatchObject({
    privateHost: '127.0.0.1',
    publicHost: '127.0.0.1',
    publicPort: null,
  });
  expect(() => listenerConfig({ NEONDECK_PRIVATE_HOST: '0.0.0.0' })).toThrow(
    'loopback',
  );
  expect(() => listenerConfig({ NEONDECK_INGRESS_PORT: '3583' })).toThrow(
    'differ',
  );
});
it('serves two distinct apps and closes both under one idempotent lifecycle', async () => {
  const setup = fixture();
  owned.push(setup.dispose);
  const privatePort = await port(),
    publicPort = await port();
  const stop = vi.fn(async () => {}),
    stopServices = vi.fn(async () => {}),
    pauseAdmissions = vi.fn();
  const app = new Hono().get('/api/private', (c) => c.text('private'));
  const application: HostedApplication = {
    fetch: app.fetch,
    stop,
    pauseAdmissions,
  };
  const lifecycle = await startNeondeckListeners(
    application,
    createGitHubIngress(setup.paths),
    {
      privateHost: '127.0.0.1',
      privatePort,
      publicHost: '127.0.0.1',
      publicPort,
    },
    stopServices,
  );
  owned.push(lifecycle.stop);
  expect(
    await (await fetch(`http://127.0.0.1:${privatePort}/api/private`)).text(),
  ).toBe('private');
  expect(
    (
      await fetch(`http://127.0.0.1:${publicPort}/api/private`, {
        headers: { host: 'localhost', origin: 'http://localhost' },
      })
    ).status,
  ).toBe(404);
  expect((await fetch(`http://127.0.0.1:${publicPort}/health`)).ok).toBe(true);
  await lifecycle.stop();
  await lifecycle.stop();
  expect(stop).toHaveBeenCalledTimes(1);
  expect(stopServices).toHaveBeenCalledTimes(1);
  expect(pauseAdmissions).toHaveBeenCalledTimes(1);
  await expect(
    fetch(`http://127.0.0.1:${publicPort}/health`),
  ).rejects.toThrow();
  await expect(
    fetch(`http://127.0.0.1:${privatePort}/api/private`),
  ).rejects.toThrow();
});
it('rolls back private bind and runtime when the public port is occupied', async () => {
  const occupied = createServer();
  const privatePort = await port();
  await new Promise<void>((resolve, reject) => {
    occupied.once('error', reject);
    occupied.listen(0, '127.0.0.1', resolve);
  });
  owned.push(
    () => new Promise<void>((resolve) => occupied.close(() => resolve())),
  );
  const address = occupied.address();
  if (!address || typeof address === 'string')
    throw new Error('Port unavailable');
  const stop = vi.fn(async () => {});
  await expect(
    startNeondeckListeners(
      { fetch: () => new Response('private'), stop, pauseAdmissions() {} },
      { fetch: () => new Response('public') },
      {
        privateHost: '127.0.0.1',
        privatePort,
        publicHost: '127.0.0.1',
        publicPort: address.port,
      },
    ),
  ).rejects.toThrow();
  expect(stop).toHaveBeenCalledTimes(1);
  await expect(fetch(`http://127.0.0.1:${privatePort}/`)).rejects.toThrow();
});
