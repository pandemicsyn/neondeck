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
            if (args.length === 1 && args[0] === 'remote') return 'upstream';
            if (args[0] === 'remote' && args[1] === 'get-url') {
              return credentialed;
            }
            throw new Error(`cannot access ${credentialed}`);
          },
        },
      ),
    ).rejects.toThrow(
      'Could not fetch exact PR head from https://git.example.test/contributor/sample.git',
    );
    expect(calls[2]).toEqual([
      'fetch',
      '--no-tags',
      '--force',
      '--',
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
            if (args.length === 1 && args[0] === 'remote') return 'upstream';
            if (args[0] === 'remote' && args[1] === 'get-url') {
              return credentialed;
            }
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
              return args.length === 1
                ? 'upstream'
                : 'https://git.example.test/base/sample.git';
            },
          },
        ),
      ).rejects.toThrow('must not embed credentials');
      expect(calls).toEqual([
        ['remote'],
        ['remote', 'get-url', '--all', '--', 'upstream'],
      ]);
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
            return args.length === 1
              ? 'upstream'
              : 'https://git.example.test/base/sample.git';
          },
        },
      ),
    ).rejects.toThrow('protocol custom-transport: is not supported');
    expect(calls).toEqual([
      ['remote'],
      ['remote', 'get-url', '--all', '--', 'upstream'],
    ]);
  });

  it('rejects option-like refs and dot repository components before invoking git', async () => {
    for (const invalid of [
      { baseRepoFullName: './sample', headRef: 'feature' },
      { baseRepoFullName: 'base/..', headRef: 'feature' },
      { baseRepoFullName: 'base/sample', headRef: '.hidden/work' },
    ]) {
      const calls: string[][] = [];
      await expect(
        fetchExactPullRequestHead(
          {
            sourceRepoPath: '/repo',
            baseRepoFullName: invalid.baseRepoFullName,
            headRepoFullName: 'base/sample',
            prNumber: 42,
            headRef: invalid.headRef,
            headSha: 'a'.repeat(40),
          },
          { runGit: async (_cwd, args) => (calls.push(args), '') },
        ),
      ).rejects.toThrow(/safe Git branch|owner\/name/);
      expect(calls).toEqual([]);
    }
  });

  it('redacts credential, query, and fragment data in ambiguous remote diagnostics', async () => {
    const secret = ['private', 'token'].join('-');
    const runGit = async (_cwd: string, args: string[]) => {
      if (args.length === 1) return 'first\nsecond';
      return `https://user:${secret}@git.example.test/base/sample.git?auth=${secret}#${secret}`;
    };
    let failure: unknown;
    try {
      await fetchExactPullRequestHead(
        {
          sourceRepoPath: '/repo',
          baseRepoFullName: 'base/sample',
          headRepoFullName: 'base/sample',
          prNumber: 42,
          headRef: 'feature',
          headSha: 'a'.repeat(40),
        },
        { runGit },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain(secret);
  });
});
