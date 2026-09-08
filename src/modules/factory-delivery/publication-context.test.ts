import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearGitHubRequestCache } from '../github';
import {
  prepareFactoryPublicationContext,
  resolveFactoryPublicationContext,
} from './publication-context';
const repo = {
  id: 'fixture',
  github: { owner: 'example', name: 'fixture' },
  defaultBranch: 'main',
};
const metadata = { id: 42, owner: { login: 'example' }, name: 'fixture' };
const legacy = {
  id: 'fixture',
  enabled: false,
  repoId: 'fixture',
  repositoryId: '42',
  owner: 'example',
  name: 'fixture',
  tokenEnv: 'GITHUB_TOKEN',
  webhookSecretEnv: 'UNUSED_SECRET',
  admission: { mode: 'all' as const },
};
beforeEach(() => {
  clearGitHubRequestCache();
  vi.stubEnv('GITHUB_TOKEN', 'synthetic-fixture-token');
});
afterEach(() => {
  clearGitHubRequestCache();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it('prepares manual publication without intake or webhook configuration', async () => {
  const fetch = vi.fn(async () => Response.json(metadata));
  vi.stubGlobal('fetch', fetch);
  const config = { github: [] };
  const result = await prepareFactoryPublicationContext(repo, config);
  expect(result).toEqual({
    connection: {
      owner: 'example',
      name: 'fixture',
      repositoryId: '42',
      tokenEnv: 'GITHUB_TOKEN',
    },
    baseBranch: 'main',
    publication: {
      repoId: 'fixture',
      repositoryId: '42',
      tokenEnv: 'GITHUB_TOKEN',
    },
  });
  expect(config).toEqual({ github: [] });
  expect(fetch.mock.calls).toHaveLength(1);
});
it('reuses disabled legacy metadata synchronously without webhook credentials', () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Unexpected network');
    }),
  );
  expect(
    resolveFactoryPublicationContext(repo, { github: [legacy] }),
  ).toMatchObject({
    source: 'configured-intake',
    baseBranch: 'main',
    connection: { repositoryId: '42' },
  });
});
it('prefers explicit publication independently of intake', () => {
  expect(
    resolveFactoryPublicationContext(repo, {
      github: [{ ...legacy, name: 'other' }],
      publication: [
        { repoId: repo.id, repositoryId: '42', tokenEnv: 'GITHUB_TOKEN' },
      ],
    }).source,
  ).toBe('publication');
});
it('fails closed for missing tokens, invalid references, ambiguous and invalid mappings', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  expect(() => resolveFactoryPublicationContext(repo, { github: [] })).toThrow(
    'Configure',
  );
  expect(() =>
    resolveFactoryPublicationContext(repo, {
      github: [{ ...legacy, name: 'other' }],
    }),
  ).toThrow('match');
  expect(() =>
    resolveFactoryPublicationContext(repo, { github: [legacy, legacy] }),
  ).toThrow('ambiguous');
  expect(() =>
    resolveFactoryPublicationContext(repo, {
      github: [{ ...legacy, tokenEnv: 'bad-ref' }],
    }),
  ).toThrow('invalid');
  await expect(
    prepareFactoryPublicationContext(
      repo,
      { github: [] },
      { tokenEnv: 42 as unknown as string },
    ),
  ).rejects.toThrow('reference');
  vi.stubEnv('GITHUB_TOKEN', '');
  expect(() =>
    resolveFactoryPublicationContext(repo, { github: [legacy] }),
  ).toThrow('GITHUB_TOKEN');
  await expect(
    prepareFactoryPublicationContext(repo, { github: [] }),
  ).rejects.toThrow('GITHUB_TOKEN');
  expect(fetch).not.toHaveBeenCalled();
});
it('validates metadata including cached 304 bodies and configured identity', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json(metadata, { headers: { etag: 'fixture-etag' } }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 304 }));
  vi.stubGlobal('fetch', fetch);
  await prepareFactoryPublicationContext(repo, { github: [] });
  await expect(
    prepareFactoryPublicationContext(repo, {
      github: [{ ...legacy, repositoryId: '43' }],
    }),
  ).rejects.toThrow('identity changed');
  expect(
    new Headers(fetch.mock.calls[1]![1].headers).get('if-none-match'),
  ).toBe('fixture-etag');
});
it.each([
  { ...metadata, id: Number.MAX_SAFE_INTEGER + 1 },
  { ...metadata, name: 'other' },
  { ...metadata, id: '42' },
])('rejects invalid external metadata', async (body) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(body)),
  );
  await expect(
    prepareFactoryPublicationContext(repo, { github: [] }),
  ).rejects.toThrow('verify');
});
