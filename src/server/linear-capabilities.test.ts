import { createHmac, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  setup,
  releasedFixture,
  issue,
} from '../modules/factory/testing/linear-fixture';
import { createLinearIngress } from './linear-ingress';
import { getFactoryWork } from '../modules/factory/service';
import { getCodingRun } from '../modules/coding-runs';
import { runFactoryLinearSync } from '../modules/factory/linear-reconcile';

it('authenticates and applies a signed removal with no API token', async () => {
  const { paths, c, current, run } = releasedFixture();
  const secret = process.env[c.webhookSecretEnv]!;
  delete process.env[c.tokenEnv];
  const body = JSON.stringify({
    action: 'remove',
    type: 'Issue',
    organizationId: c.organizationId,
    webhookTimestamp: Date.now(),
    createdAt: '2026-09-07T03:00:00Z',
    data: { id: issue.id },
  });
  const app = createLinearIngress(paths);
  const response = await app.request(`http://localhost/hooks/linear/${c.id}`, {
    method: 'POST',
    body,
    headers: {
      'linear-event': 'Issue',
      'linear-delivery': randomUUID(),
      'linear-signature': createHmac('sha256', secret)
        .update(body)
        .digest('hex'),
    },
  });
  expect(response.status).toBe(200);
  const forged = await app.request(`http://localhost/hooks/linear/${c.id}`, {
    method: 'POST',
    body,
    headers: {
      'linear-event': 'Issue',
      'linear-delivery': randomUUID(),
      'linear-signature': '0'.repeat(64),
    },
  });
  expect(forged.status).toBe(401);
  const io = {
    readIssue: vi.fn(async () => issue),
    readPage: vi.fn(async () => ({ items: [], cursor: null })),
    planning: vi.fn(async () => {}),
  };
  await runFactoryLinearSync(paths, undefined, io);
  expect(io.readIssue).not.toHaveBeenCalled();
  expect(io.readPage).not.toHaveBeenCalled();
  expect(io.planning).not.toHaveBeenCalled();
  expect(
    getFactoryWork(current.work.id, paths).releases[0].withdrawnAt,
  ).not.toBeNull();
  expect(getCodingRun(run.runId, paths)!.cancelRequestedAt).not.toBeNull();
});

it('requires the webhook credential for signed ingress', async () => {
  const { paths, c } = setup(true);
  const secret = process.env[c.webhookSecretEnv]!;
  delete process.env[c.webhookSecretEnv];
  const body = JSON.stringify({
    action: 'remove',
    type: 'Issue',
    organizationId: c.organizationId,
    webhookTimestamp: Date.now(),
    createdAt: issue.updatedAt,
    data: { id: issue.id },
  });
  const rejected = await createLinearIngress(paths).request(
    `http://localhost/hooks/linear/${c.id}`,
    {
      method: 'POST',
      body,
      headers: {
        'linear-event': 'Issue',
        'linear-delivery': randomUUID(),
        'linear-signature': createHmac('sha256', secret)
          .update(body)
          .digest('hex'),
      },
    },
  );
  expect(rejected.status).toBe(409);
});
