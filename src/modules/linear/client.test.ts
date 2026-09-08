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
function respondIssue(current: typeof issue | null, organizationId = 'org') {
  return respond({
    organization: { id: organizationId },
    issues: {
      nodes: current ? [{ ...current, trashed: null }] : [],
      pageInfo: { hasNextPage: false },
    },
  });
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.LINEAR_TEST_TOKEN;
});
it.each([100, 101])(
  'validates the %s-label boundary even when provider claims the page is complete',
  async (count) => {
    const labels = Array.from({ length: count }, (_, index) => ({
      id: `label-${index}`,
    }));
    const data = {
      organization: { id: 'org' },
      issues: {
        nodes: [
          {
            ...issue,
            trashed: null,
            labels: { nodes: labels, pageInfo: { hasNextPage: false } },
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    };
    respond(data);
    if (count === 100) {
      expect(
        (await readLinearIssue(connection, issue.id))?.labels,
      ).toHaveLength(100);
      respond(data);
      expect(
        (await readLinearIssuesPage(connection, null)).items[0].labels,
      ).toHaveLength(100);
    } else {
      await expect(readLinearIssue(connection, issue.id)).rejects.toThrow(
        'invalid result',
      );
      respond(data);
      await expect(readLinearIssuesPage(connection, null)).rejects.toThrow(
        'invalid result',
      );
    }
  },
);

it('recognizes Linear HTTP400 rate limits without accepting other HTTP400 data', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json(
        {
          errors: [{ extensions: { code: 'RATELIMITED' } }],
        },
        { status: 400, headers: { 'retry-after': '120' } },
      ),
    ),
  );
  await expect(linearGraphql('token', 'query {}', {})).rejects.toMatchObject({
    status: 429,
    rateLimited: true,
  });
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ data: { ok: true } }, { status: 400 }),
      ),
  );
  await expect(linearGraphql('token', 'query {}', {})).rejects.toMatchObject({
    status: 400,
    rateLimited: false,
  });
});

it.each([2000, 2001])(
  'validates provider cursor length %s against durable storage bounds',
  async (length) => {
    const cursor = 'x'.repeat(length);
    respond({
      organization: { id: 'org' },
      issues: {
        nodes: [],
        pageInfo: { hasNextPage: true, endCursor: cursor },
      },
    });
    if (length === 2000)
      await expect(readLinearIssuesPage(connection, null)).resolves.toEqual({
        items: [],
        cursor,
      });
    else
      await expect(readLinearIssuesPage(connection, null)).rejects.toThrow(
        'invalid result',
      );
  },
);
it('uses fixed endpoint, credential and raw GraphQL variables and normalizes issue labels', async () => {
  const mock = respondIssue(issue);
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
      body: expect.stringContaining('"id":{"eq":"issue"}'),
    }),
  );
});
it('rejects wrong workspace, mismatched identity and truncated labels', async () => {
  respondIssue(issue, 'other');
  await expect(readLinearIssue(connection, 'issue')).rejects.toThrow(
    'organization',
  );
  respondIssue(issue);
  await expect(readLinearIssue(connection, 'other')).rejects.toThrow(
    'identity',
  );
  respondIssue({
    ...issue,
    labels: { nodes: [], pageInfo: { hasNextPage: true } },
  });
  await expect(readLinearIssue(connection, 'issue')).rejects.toThrow('labels');
});
it('pages with an opaque cursor and refuses a non-advancing cursor', async () => {
  const data = {
    organization: { id: 'org' },
    issues: {
      nodes: [{ ...issue, trashed: null }],
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

it('does not discover explicitly trashed issues and preserves the page cursor', async () => {
  respond({
    organization: { id: 'org' },
    issues: {
      nodes: [{ ...issue, trashed: true }],
      pageInfo: { hasNextPage: true, endCursor: 'next' },
    },
  });
  await expect(readLinearIssuesPage(connection, null)).resolves.toEqual({
    items: [],
    cursor: 'next',
  });
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
  ).rejects.toThrow('Linear request failed.');
  expect(fence).toHaveBeenCalledTimes(1);
  expect(mock).toHaveBeenCalledTimes(1);
});

it('returns source absence only from a complete exact-ID result in the bound organization', async () => {
  const mock = respondIssue(null);
  await expect(readLinearIssue(connection, 'issue')).resolves.toBeNull();
  const request = JSON.parse(mock.mock.calls[0][1].body);
  expect(request.variables).toEqual({ filter: { id: { eq: 'issue' } } });
  expect(request.query).toContain('includeArchived: true');
  expect(request.query).not.toContain('teamId');
  respondIssue(null, 'other');
  await expect(readLinearIssue(connection, 'issue')).rejects.toThrow(
    'organization',
  );
  respond({
    organization: { id: 'org' },
    issues: {
      nodes: [{ ...issue, trashed: true }],
      pageInfo: { hasNextPage: false },
    },
  });
  await expect(readLinearIssue(connection, 'issue')).resolves.toBeNull();
});

it.each([
  { nodes: [], pageInfo: { hasNextPage: true } },
  { nodes: [], pageInfo: {} },
  { nodes: null, pageInfo: { hasNextPage: false } },
  { nodes: [issue], pageInfo: { hasNextPage: false } },
  {
    nodes: [
      { ...issue, trashed: false },
      { ...issue, trashed: false },
    ],
    pageInfo: { hasNextPage: false },
  },
])(
  'does not turn malformed or incomplete issue collections into absence',
  async (issues) => {
    respond({ organization: { id: 'org' }, issues });
    await expect(readLinearIssue(connection, 'issue')).rejects.toThrow();
  },
);

it.each([
  'ENTITY_NOT_FOUND',
  'FORBIDDEN',
  'UNAUTHENTICATED',
  'INTERNAL_SERVER_ERROR',
  'RATELIMITED',
])('does not infer absence from GraphQL %s', async (code) => {
  process.env.LINEAR_TEST_TOKEN = 'synthetic';
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json({
        data: {
          organization: { id: 'org' },
          issues: { nodes: [], pageInfo: { hasNextPage: false } },
        },
        errors: [{ extensions: { code } }],
      }),
    ),
  );
  await expect(readLinearIssue(connection, 'issue')).rejects.toThrow();
});

it.each([401, 403, 404, 429, 500])(
  'does not infer absence from HTTP %s',
  async (status) => {
    process.env.LINEAR_TEST_TOKEN = 'synthetic';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            data: {
              organization: { id: 'org' },
              issues: { nodes: [], pageInfo: { hasNextPage: false } },
            },
          },
          { status },
        ),
      ),
    );
    await expect(readLinearIssue(connection, 'issue')).rejects.toThrow();
  },
);

it('does not mark mutation dispatch when organization preflight fails or the caller aborts', async () => {
  const fence = vi.fn();
  respond({ organization: { id: 'wrong' } });
  await expect(
    updateLinearIssueState(connection, 'issue', 'target', undefined, fence),
  ).rejects.toThrow();
  expect(fence).not.toHaveBeenCalled();
  const controller = new AbortController();
  const fetcher = respond({ organization: { id: 'org' } });
  controller.abort();
  await expect(
    updateLinearIssueState(
      connection,
      'issue',
      'target',
      controller.signal,
      fence,
    ),
  ).rejects.toThrow();
  expect(fence).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});

it('marks dispatch immediately before the mutation fetch', async () => {
  process.env.LINEAR_TEST_TOKEN = 'synthetic';
  const sequence: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((_url, init) => {
      if (JSON.parse(init.body).query.startsWith('query')) {
        sequence.push('preflight');
        return Promise.resolve(
          Response.json({ data: { organization: { id: 'org' } } }),
        );
      }
      sequence.push('mutation');
      return Promise.resolve(
        Response.json({
          data: {
            issueUpdate: {
              success: true,
              issue: {
                id: 'issue',
                state: { id: 'target' },
                updatedAt: issue.updatedAt,
              },
            },
          },
        }),
      );
    }),
  );
  await updateLinearIssueState(connection, 'issue', 'target', undefined, () => {
    sequence.push('dispatch');
  });
  expect(sequence).toEqual(['preflight', 'dispatch', 'mutation']);
});
