import { describe, expect, it } from 'vitest';
import { deriveForkRemote, fetchExactPullRequestHead } from './pr-head';

describe('exact PR head fetch safety', () => {
  it('derives fork remotes from the configured custom host and transport', () => {
    const basicAuth = ['user', 'secret'].join(':');
    expect(
      deriveForkRemote(
        `https://${basicAuth}@git.example.test/base/sample.git`,
        'contributor/sample',
      ),
    ).toBe('https://git.example.test/contributor/sample.git');
    expect(
      deriveForkRemote(
        'git@git.example.test:base/sample.git',
        'contributor/sample',
      ),
    ).toBe('git@git.example.test:contributor/sample.git');
  });

  it('uses noninteractive bounded fetch arguments and redacts credentials on failure', async () => {
    const credentialed = `https://${['automation', 'private-token'].join(':')}@git.example.test/base/sample.git`;
    const calls: string[][] = [];

    await expect(
      fetchExactPullRequestHead(
        {
          sourceRepoPath: '/repo',
          baseRepoFullName: 'base/sample',
          headRepoFullName: 'contributor/sample',
          prNumber: 42,
          headRef: 'feature',
          headSha: 'a'.repeat(40),
        },
        {
          runGit: async (_cwd, args) => {
            calls.push(args);
            if (args[0] === 'remote') return credentialed;
            throw new Error(`cannot access ${credentialed}`);
          },
        },
      ),
    ).rejects.toThrow(
      'Could not fetch exact PR head from https://git.example.test/contributor/sample.git',
    );
    expect(calls[1]).toEqual([
      'fetch',
      '--no-tags',
      '--force',
      'https://git.example.test/contributor/sample.git',
      'refs/heads/feature:refs/neondeck/autopilot/pr-42',
    ]);
    await expect(
      fetchExactPullRequestHead(
        {
          sourceRepoPath: '/repo',
          baseRepoFullName: 'base/sample',
          headRepoFullName: 'contributor/sample',
          prNumber: 42,
          headRef: 'feature',
          headSha: 'a'.repeat(40),
        },
        {
          runGit: async (_cwd, args) => {
            if (args[0] === 'remote') return credentialed;
            throw new Error(`cannot access ${credentialed}`);
          },
        },
      ),
    ).rejects.not.toThrow(/private-token/);
  });

  it('rejects credential-bearing resolver URLs before invoking git fetch', async () => {
    const auth = ['automation', 'private-token'].join(':');
    for (const transport of ['https', 'ftp']) {
      const resolvedRemote = `${transport}://${auth}@git.example.test/contributor/sample.git`;
      const calls: string[][] = [];
      await expect(
        fetchExactPullRequestHead(
          {
            sourceRepoPath: '/repo',
            baseRepoFullName: 'base/sample',
            headRepoFullName: 'contributor/sample',
            prNumber: 42,
            headRef: 'feature',
            headSha: 'a'.repeat(40),
          },
          {
            resolveForkRemote: () => resolvedRemote,
            runGit: async (_cwd, args) => {
              calls.push(args);
              return 'https://git.example.test/base/sample.git';
            },
          },
        ),
      ).rejects.toThrow('must not embed credentials');
      expect(calls).toEqual([['remote', 'get-url', 'origin']]);
    }
  });

  it('rejects unsupported URL-form resolver transports before invoking git fetch', async () => {
    const calls: string[][] = [];
    await expect(
      fetchExactPullRequestHead(
        {
          sourceRepoPath: '/repo',
          baseRepoFullName: 'base/sample',
          headRepoFullName: 'contributor/sample',
          prNumber: 42,
          headRef: 'feature',
          headSha: 'a'.repeat(40),
        },
        {
          resolveForkRemote: () =>
            'custom-transport://git.example.test/contributor/sample.git',
          runGit: async (_cwd, args) => {
            calls.push(args);
            return 'https://git.example.test/base/sample.git';
          },
        },
      ),
    ).rejects.toThrow('protocol custom-transport: is not supported');
    expect(calls).toEqual([['remote', 'get-url', 'origin']]);
  });
});
