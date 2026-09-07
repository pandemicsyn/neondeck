import { afterEach, expect, it, vi } from 'vitest';
import { issue, releasedFixture } from './testing/linear-fixture';
import { runFactoryLinearSync } from './linear-reconcile';
import { dbRun, getFactoryWork } from './service';
import { getCodingRun } from '../coding-runs';
import { assertCodingAuthoritySnapshot } from './coding-context';
import { runFactoryLinearWriteback } from './linear-writeback';
import { linearRecords, putLinearRecord } from './linear-store';
import { updateFactoryConfig } from '../config';

afterEach(() => vi.unstubAllGlobals());

function sourceResponse(trashed: boolean | null | 'absent') {
  return Response.json({
    data: {
      organization: { id: 'org' },
      issues: {
        nodes:
          trashed === 'absent'
            ? []
            : [
                {
                  ...issue,
                  trashed,
                  labels: {
                    nodes: issue.labels,
                    pageInfo: { hasNextPage: false },
                  },
                },
              ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  });
}

it.each(['absent', true] as const)(
  'revokes retained reserved authority after actual transport observes %s',
  async (absent) => {
    const { paths, current, run } = releasedFixture();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(sourceResponse(absent))),
    );
    // Discovery and retained-source phases each own a bounded tick.
    await runFactoryLinearSync(paths);
    await runFactoryLinearSync(paths);
    expect(
      getFactoryWork(current.work.id, paths).releases.every(
        (release) => release.withdrawnAt !== null,
      ),
    ).toBe(true);
    expect(getCodingRun(run.runId, paths)!.cancelRequestedAt).not.toBeNull();
    expect(() => assertCodingAuthoritySnapshot(run.snapshot, paths)).toThrow();
    const version = getFactoryWork(current.work.id, paths).source.version;
    await runFactoryLinearSync(paths);
    await runFactoryLinearSync(paths);
    expect(getFactoryWork(current.work.id, paths).source.version).toBe(version);
  },
);

it.each([
  'FORBIDDEN',
  'ENTITY_NOT_FOUND',
  'INTERNAL_SERVER_ERROR',
  'RATELIMITED',
])('preserves authority on actual ambiguous GraphQL error %s', async (code) => {
  const { paths, current, run } = releasedFixture();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() =>
      Promise.resolve(
        Response.json({
          data: null,
          errors: [{ extensions: { code } }],
        }),
      ),
    ),
  );
  await runFactoryLinearSync(paths);
  await runFactoryLinearSync(paths);
  expect(getFactoryWork(current.work.id, paths).source.version).toBe(
    current.source.version,
  );
  expect(getCodingRun(run.runId, paths)!.cancelRequestedAt).toBeNull();
  expect(() =>
    assertCodingAuthoritySnapshot(run.snapshot, paths),
  ).not.toThrow();
});

it.each([429, 503])(
  'retries actual transport preflight HTTP %s without inventing an uncertain mutation',
  async (status) => {
    const { paths, c } = releasedFixture(true);
    updateFactoryConfig(
      {
        linear: [
          { ...c, writeback: { enabled: true, states: { queued: 'started' } } },
        ],
      },
      paths,
    );
    let rejectPreflight = true;
    const operations: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { query: string };
        if (request.query.includes('query FactoryIssue(')) {
          operations.push('source');
          return sourceResponse(null);
        }
        if (request.query.includes('query FactoryOrganization')) {
          operations.push('preflight');
          return rejectPreflight
            ? Response.json(
                { error: 'preflight unavailable' },
                { status, headers: { 'retry-after': '1' } },
              )
            : Response.json({ data: { organization: { id: 'org' } } });
        }
        expect(request.query).toContain('mutation FactoryState');
        operations.push('mutation');
        return Response.json({
          data: {
            issueUpdate: {
              success: true,
              issue: {
                id: issue.id,
                updatedAt: '2026-09-07T01:00:00Z',
                state: { id: 'started' },
              },
            },
          },
        });
      }),
    );
    await runFactoryLinearWriteback(paths);
    const pending = dbRun(paths, (db) => linearRecords(db, 'writeback'));
    expect(operations).toEqual(['source', 'preflight']);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ state: 'pending', attempts: 0 });
    expect(pending[0].retryAt).toBeGreaterThan(Date.now());
    // Advance only the isolated fixture's durable retry records, without sleeping.
    dbRun(paths, (db) => {
      putLinearRecord(db, { ...pending[0], retryAt: 0 });
      for (const cooldown of linearRecords(db, 'sync', {
        id: `cooldown:${c.id}`,
      }))
        putLinearRecord(db, { ...cooldown, retryAt: 0 });
    });
    rejectPreflight = false;
    await runFactoryLinearWriteback(paths);
    expect(operations).toEqual([
      'source',
      'preflight',
      'source',
      'preflight',
      'mutation',
    ]);
    const complete = dbRun(paths, (db) => linearRecords(db, 'writeback'));
    expect(complete).toHaveLength(1);
    expect(complete[0]).toMatchObject({
      id: pending[0].id,
      state: 'complete',
      attempts: 1,
      updatedAt: '2026-09-07T01:00:00Z',
    });
  },
);
