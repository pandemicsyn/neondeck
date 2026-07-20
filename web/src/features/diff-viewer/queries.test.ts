import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { diffViewerQueryKeys } from './queries';

describe('diff viewer revision query families', () => {
  it('keeps managed-worktree diffs bound to their retained PR head', () => {
    expect(
      diffViewerQueryKeys.repoDiff({
        repoId: 'repo-1',
        worktreeId: 'worktree-1',
        base: 'pr-head-a',
      }),
    ).not.toEqual(
      diffViewerQueryKeys.repoDiff({
        repoId: 'repo-1',
        worktreeId: 'worktree-1',
        base: 'pr-head-b',
      }),
    );
  });

  it('keeps prepared patch bodies revision-bound', () => {
    expect(
      diffViewerQueryKeys.preparedDiffFile(
        'prepared-1',
        'worktree-diff:base:revision-a',
        'src/app.ts',
      ),
    ).not.toEqual(
      diffViewerQueryKeys.preparedDiffFile(
        'prepared-1',
        'worktree-diff:base:revision-b',
        'src/app.ts',
      ),
    );
  });

  it('invalidates prepared metadata without relabeling or invalidating its patch cache', async () => {
    const queryClient = new QueryClient();
    const metadataKey = diffViewerQueryKeys.preparedDiffFiles('prepared-1');
    const patchKey = diffViewerQueryKeys.preparedDiffFile(
      'prepared-1',
      'worktree-diff:base:revision-a',
      'src/app.ts',
    );
    queryClient.setQueryData(metadataKey, { revision: 'revision-a' });
    queryClient.setQueryData(patchKey, { patch: 'cached-a' });

    await queryClient.invalidateQueries({ exact: true, queryKey: metadataKey });

    expect(queryClient.getQueryState(metadataKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(patchKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryData(patchKey)).toEqual({ patch: 'cached-a' });
    queryClient.clear();
  });

  it('invalidates only Kilo metadata across a 305-file refresh and retains cached patch bodies', async () => {
    const queryClient = new QueryClient();
    const metadataKey = diffViewerQueryKeys.repoDiff({
      repoId: 'repo-1',
      worktreeId: 'worktree-1',
    });
    queryClient.setQueryData(metadataKey, { revision: 'revision-a' });
    const patchKeys = Array.from({ length: 305 }, (_, index) =>
      diffViewerQueryKeys.repoDiff({
        repoId: 'repo-1',
        worktreeId: 'worktree-1',
        paths: [`src/file-${index.toString().padStart(3, '0')}.ts`],
        revisionKey: 'worktree-diff:base:revision-a',
      }),
    );
    for (const [index, key] of patchKeys.entries()) {
      queryClient.setQueryData(key, { patch: `cached-${index}` });
    }

    await queryClient.invalidateQueries({ exact: true, queryKey: metadataKey });

    expect(
      patchKeys.filter((key) => queryClient.getQueryState(key)?.isInvalidated),
    ).toHaveLength(0);
    expect(queryClient.getQueryData(patchKeys[304]!)).toEqual({
      patch: 'cached-304',
    });
    expect(queryClient.getQueryState(metadataKey)?.isInvalidated).toBe(true);
    queryClient.clear();
  });
});
