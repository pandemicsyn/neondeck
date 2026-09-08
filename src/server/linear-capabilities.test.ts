import { createHmac, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  setup,
  releasedFixture,
  issue,
} from '../modules/factory/testing/linear-fixture';
import { createLinearIngress } from './linear-ingress';
import { dbRun, getFactoryWork } from '../modules/factory/service';
import { linearFingerprint } from '../modules/factory/linear-config';
import { linearRecords } from '../modules/factory/linear-store';
import { getCodingRun } from '../modules/coding-runs';
import { runFactoryLinearSync } from '../modules/factory/linear-reconcile';

it.each([false, true])(
  'authenticates and applies a signed removal with no API token (read queue full: %s)',
  async (fullQueue) => {
    const { paths, c, current, run } = releasedFixture();
    if (fullQueue)
      dbRun(paths, (db) => {
        const insert = db.prepare(
          "INSERT INTO factory_linear_records(id,kind,record) VALUES(?,'delivery',?)",
        );
        for (let index = 0; index < 5000; index++) {
          const id = `delivery:backlog-${index}`;
          insert.run(
            id,
            JSON.stringify({
              id,
              kind: 'delivery',
              connectionId: c.id,
              connectionFingerprint: linearFingerprint(c),
              issueId: `backlog-${index}`,
              action: index % 2 ? 'create' : 'update',
              state: 'pending',
              retryAt: 0,
              attempts: 0,
              error: null,
              digest: id,
              createdAt: '2026-09-07T00:00:00Z',
            }),
          );
        }
      });
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
    const response = await app.request(
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
    expect(
      dbRun(paths, (db) =>
        linearRecords(db, 'delivery', { action: 'remove' }),
      )[0].state,
    ).toBe('complete');
  },
);

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
