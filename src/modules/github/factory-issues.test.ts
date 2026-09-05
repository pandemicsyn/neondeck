import { afterEach, expect, it, vi } from 'vitest';
import {
  readFactoryGitHubIssue,
  readFactoryGitHubIssuesPage,
} from './factory-issues';
import type { GitHubConnection } from '../../../shared/factory-github';
const connection: GitHubConnection = {
  id: 'synthetic',
  enabled: true,
  repoId: 'test',
  repositoryId: '42',
  owner: 'example',
  name: 'fixture',
  tokenEnv: 'SYNTHETIC_TOKEN',
  webhookSecretEnv: 'SYNTHETIC_SECRET',
  admission: { mode: 'all' },
};
const issue = {
  id: 101,
  number: 1,
  title: 'Title',
  body: 'Body',
  state: 'open',
  updated_at: '2026-09-01T00:00:00Z',
  user: { login: 'synthetic' },
  labels: [],
};
vi.mock('./client', () => ({
  githubFetch: (...args: unknown[]) => fetch(String(args[1])),
  nextLink: () => null,
}));
afterEach(() => vi.unstubAllGlobals());
it('reads discovery identity even when issue content exceeds local limits', async () => {
  const invalid = { ...issue, title: 'x'.repeat(256), body: 'x'.repeat(65537) };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json([invalid, { ...issue, id: 102, number: 2 }]),
    ),
  );
  const result = await readFactoryGitHubIssuesPage(
    connection,
    issue.updated_at,
    1,
  );
  expect(result.items.map((i) => i.id)).toEqual([101, 102]);
  expect(result.items[0]).not.toHaveProperty('body');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(invalid)),
  );
  await expect(readFactoryGitHubIssue(connection, 1)).rejects.toThrow();
});
