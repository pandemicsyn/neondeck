import { describe, expect, it } from 'vitest';
import { buildPullRequestQueries } from './github';
import type { RepoConfig } from './runtime-home';

describe('github foundation', () => {
  it('builds user and configured repo PR queries', () => {
    const repos: RepoConfig[] = [
      {
        id: 'neondeck',
        github: { owner: 'pandemicsyn', name: 'neondeck' },
        path: '/src/neondeck',
        defaultBranch: 'main',
      },
      {
        id: 'flue',
        github: { owner: 'pandemicsyn', name: 'flue' },
        path: '/src/flue',
        defaultBranch: 'main',
      },
    ];

    expect(buildPullRequestQueries('pandemicsyn', repos)).toEqual([
      'is:pr is:open archived:false author:pandemicsyn',
      'is:pr is:open archived:false assignee:pandemicsyn',
      'is:pr is:open archived:false review-requested:pandemicsyn',
      'is:pr is:open archived:false repo:pandemicsyn/neondeck',
      'is:pr is:open archived:false repo:pandemicsyn/flue',
    ]);
  });

  it('deduplicates duplicate configured repo queries', () => {
    const repos: RepoConfig[] = [
      {
        id: 'neondeck',
        github: { owner: 'pandemicsyn', name: 'neondeck' },
        path: '/src/neondeck',
        defaultBranch: 'main',
      },
      {
        id: 'neondeck-copy',
        github: { owner: 'pandemicsyn', name: 'neondeck' },
        path: '/src/neondeck-copy',
        defaultBranch: 'main',
      },
    ];

    expect(
      buildPullRequestQueries('pandemicsyn', repos).filter((query) =>
        query.includes('repo:pandemicsyn/neondeck'),
      ),
    ).toHaveLength(1);
  });
});
