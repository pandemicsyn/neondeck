import { afterEach, expect, it, vi } from 'vitest';
import { linearGraphql } from './client';
import {
  readLinearIssue,
  readLinearIssuesPage,
  updateLinearIssueState,
} from './issues';
import type { LinearConnection } from '../../../shared/factory-linear';
const connection: LinearConnection = {
  id: 'test',
  enabled: true,
  organizationId: 'org',
  teamId: 'team',
  projectId: null,
  repoId: 'repo',
  tokenEnv: 'LINEAR_TEST_TOKEN',
  webhookSecretEnv: 'LINEAR_TEST_SECRET',
  admission: { mode: 'all' },
  writeback: { enabled: false, states: {} },
};
const issue = {
  id: 'issue',
  identifier: 'TEAM-1',
  url: 'https://linear.app/example/issue/TEAM-1',
  title: 'Title',
  description: null,
  updatedAt: '2026-09-01T00:00:00Z',
  archivedAt: null,
  team: { id: 'team' },
  project: null,
  state: { id: 'state', type: 'started' },
  labels: { nodes: [], pageInfo: { hasNextPage: false } },
};
function respond(data: unknown) {
  const mock = vi.fn().mockResolvedValue(Response.json({ data }));
  vi.stubGlobal('fetch', mock);
  process.env.LINEAR_TEST_TOKEN = 'synthetic';
  return mock;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.LINEAR_TEST_TOKEN;
});
it('uses fixed endpoint, credential and raw GraphQL variables and normalizes issue labels', async () => {
  const mock = respond({ organization: { id: 'org' }, issue });
  expect(await readLinearIssue(connection, 'issue')).toEqual({
    ...issue,
    labels: [],
  });
  expect(mock).toHaveBeenCalledWith(
    'https://api.linear.app/graphql',
    expect.objectContaining({
      redirect: 'error',
      headers: {
        Authorization: 'synthetic',
        'Content-Type': 'application/json',
      },
      body: expect.stringContaining('"id":"issue"'),
    }),
  );
});
it('rejects wrong workspace, mismatched identity and truncated labels', async () => {
  respond({ organization: { id: 'other' }, issue });
  await expect(readLinearIssue(connection, 'issue')).rejects.toThrow(
    'organization',
  );
  respond({ organization: { id: 'org' }, issue });
  await expect(readLinearIssue(connection, 'other')).rejects.toThrow(
    'identity',
  );
  respond({
    organization: { id: 'org' },
    issue: { ...issue, labels: { nodes: [], pageInfo: { hasNextPage: true } } },
  });
  await expect(readLinearIssue(connection, 'issue')).rejects.toThrow('labels');
});
it('pages with an opaque cursor and refuses a non-advancing cursor', async () => {
  const data = {
    organization: { id: 'org' },
    issues: {
      nodes: [issue],
      pageInfo: { hasNextPage: true, endCursor: 'next' },
    },
  };
  respond(data);
  expect((await readLinearIssuesPage(connection, null)).cursor).toBe('next');
  respond(data);
  await expect(readLinearIssuesPage(connection, 'next')).rejects.toThrow(
    'advance',
  );
});
it('refuses partial GraphQL success and redacts provider text on both HTTP and GraphQL failures', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json({
        data: { ok: true },
        errors: [
          { message: 'secret-content', extensions: { code: 'RATELIMITED' } },
        ],
      }),
    ),
  );
  await expect(linearGraphql('token', 'query {}', {})).rejects.toMatchObject({
    rateLimited: true,
    status: 429,
    message: 'Linear API rate limit reached.',
  });
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ error: 'secret-content' }, { status: 401 }),
      ),
  );
  await expect(linearGraphql('token', 'query {}', {})).rejects.toMatchObject({
    status: 401,
    message: 'Linear API request failed.',
  });
});
it('bounds oversized and stalled response bodies', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(new Response(new Uint8Array(4 * 1024 * 1024 + 1))),
  );
  await expect(linearGraphql('token', 'query {}', {})).rejects.toThrow(
    'size limit',
  );
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(new ReadableStream({ start() {} }))),
  );
  const pending = expect(
    linearGraphql('token', 'query {}', {}),
  ).rejects.toThrow('deadline');
  await vi.advanceTimersByTimeAsync(15000);
  await pending;
});
it('checks organization before mutation and validates mutation receipt', async () => {
  const mock = respond({ organization: { id: 'wrong' } });
  await expect(
    updateLinearIssueState(connection, 'issue', 'target'),
  ).rejects.toThrow('organization');
  expect(mock).toHaveBeenCalledTimes(1);
  const success = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ data: { organization: { id: 'org' } } }),
    )
    .mockResolvedValueOnce(
      Response.json({
        data: {
          issueUpdate: {
            success: true,
            issue: {
              id: 'issue',
              updatedAt: issue.updatedAt,
              state: { id: 'target' },
            },
          },
        },
      }),
    );
  vi.stubGlobal('fetch', success);
  expect(
    (await updateLinearIssueState(connection, 'issue', 'target')).state.id,
  ).toBe('target');
});

it('rechecks caller authority after organization verification and before mutation', async () => {
  const mock = respond({ organization: { id: 'org' } });
  const fence = vi.fn(() => {
    throw new Error('authority withdrawn');
  });
  await expect(
    updateLinearIssueState(connection, 'issue', 'target', undefined, fence),
  ).rejects.toThrow('authority withdrawn');
  expect(fence).toHaveBeenCalledTimes(1);
  expect(mock).toHaveBeenCalledTimes(1);
});
