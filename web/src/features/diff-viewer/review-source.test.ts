import { describe, expect, it } from 'vitest';
import type {
  AutopilotPreparedDiff,
  GitHubPullRequest,
  KiloTaskRecord,
  LearningCandidate,
  RepoEditEvent,
} from '../../api';
import { resolvedReviewRevision } from '../../../../shared/review-source';
import type { DiffFilePatch } from './types';
import {
  githubPrReviewSource,
  kiloResultReviewSource,
  preparedDiffReviewSource,
  repoEditEventReviewSource,
  reviewSourceDataAttributes,
  skillPatchReviewSource,
} from './review-source';

const unloadedFile: DiffFilePatch = {
  additions: 1,
  deletions: 1,
  path: 'src/app.ts',
  status: 'M',
  patch: null,
};
const worktreeRevision = resolvedReviewRevision({
  kind: 'worktree-diff',
  id: 'tree-sha',
  baseId: 'base-sha',
});

describe('review source adapters', () => {
  it('represents a GitHub PR by immutable head SHA and explicit file state', () => {
    const source = githubPrReviewSource(githubPullRequest(), [unloadedFile], {
      localSource: true,
      loadingPaths: new Set([unloadedFile.path]),
    });

    expect(source).toMatchObject({
      id: 'github-pr:example/repo#42',
      kind: 'github-pr',
      revision: {
        state: 'resolved',
        kind: 'git-commit',
        id: 'head-sha',
        baseId: 'base-sha',
      },
      files: [
        { path: 'src/app.ts', status: 'modified', patchState: 'loading' },
      ],
    });
    expect(source.capabilities).toEqual(
      expect.arrayContaining([
        'comments',
        'context-expansion',
        'open-in-editor',
      ]),
    );
    expect(reviewSourceDataAttributes(source)).toMatchObject({
      'data-review-source-kind': 'github-pr',
      'data-review-revision-id': 'head-sha',
    });
  });

  it('uses content-addressed worktree revisions for prepared and Kilo sources', () => {
    const prepared = preparedDiffReviewSource(
      preparedDiff(),
      [unloadedFile],
      worktreeRevision,
    );
    const kilo = kiloResultReviewSource(
      kiloTask(),
      [{ ...unloadedFile, patch: '@@ -1 +1 @@\n-old\n+new\n' }],
      worktreeRevision,
    );

    expect(prepared).toMatchObject({
      id: 'prepared-diff:prepared-1',
      revision: worktreeRevision,
      repository: { worktreeId: 'worktree-1', localAccess: true },
    });
    expect(kilo).toMatchObject({
      id: 'kilo-result:kilo-1',
      revision: worktreeRevision,
      files: [{ patchState: 'available' }],
    });
  });

  it('uses retained content identities for skill patches and repo-edit events', () => {
    const skill = skillPatchReviewSource(
      learningCandidate(),
      [unloadedFile],
      'after-sha',
      'Runtime skill',
    );
    const event = repoEditEventReviewSource(repoEditEvent(), [unloadedFile]);

    expect(skill.revision).toMatchObject({
      state: 'resolved',
      kind: 'retained-patch',
      id: 'after-sha',
    });
    expect(event).toMatchObject({
      id: 'repo-edit-event:event-1',
      revision: { id: 'patch-sha' },
    });
  });

  it('keeps unavailable revisions explicit instead of synthesizing identities', () => {
    const source = githubPrReviewSource(
      { ...githubPullRequest(), headSha: null },
      [],
      { localSource: false },
    );

    expect(source.revision).toEqual({
      state: 'unavailable',
      kind: 'git-commit',
      reason: 'The pull request head SHA is unavailable.',
    });
    expect(reviewSourceDataAttributes(source)).not.toHaveProperty(
      'data-review-revision-id',
    );
  });

  it('normalizes removed files as deleted instead of renamed', () => {
    const source = githubPrReviewSource(
      githubPullRequest(),
      [{ ...unloadedFile, status: 'removed' }],
      { localSource: false },
    );

    expect(source.files[0]?.status).toBe('deleted');
  });
});

function githubPullRequest(): GitHubPullRequest {
  return {
    id: 42,
    title: 'Review source contract',
    repo: 'Example/Repo',
    number: 42,
    url: 'https://github.com/example/repo/pull/42',
    state: 'OPEN',
    author: 'neon',
    labels: [],
    comments: 0,
    updatedAt: '2026-07-18T00:00:00.000Z',
    createdAt: '2026-07-18T00:00:00.000Z',
    relations: ['configured-repo'],
    ageDays: 0,
    stale: false,
    headSha: 'head-sha',
    baseSha: 'base-sha',
    baseRef: 'main',
    checks: null,
  };
}

function preparedDiff(): AutopilotPreparedDiff {
  return {
    id: 'prepared-1',
    repoId: 'repo-1',
    repoFullName: 'example/repo',
    prNumber: 42,
    worktreeId: 'worktree-1',
    localPath: '/tmp/worktree-1',
    title: 'Prepared change',
    status: 'prepared',
    pushApprovalStatus: 'pending',
    verificationStatus: 'not-run',
    sourceOfTruth: 'worktree',
    summary: 'Prepared change',
    revisionRun: null,
    updatedAt: '2026-07-18T00:00:00.000Z',
  };
}

function kiloTask(): KiloTaskRecord {
  return {
    id: 'kilo-1',
    title: 'Delegated change',
    prompt: 'Fix it.',
    repoId: 'repo-1',
    repoFullName: 'example/repo',
    worktreeId: 'worktree-1',
    lockId: null,
    cwd: '/tmp/worktree-1',
    mode: 'direct-edit',
    status: 'succeeded',
    explicitUserRequest: true,
    autoEnabled: false,
    cliPath: 'kilo',
    args: [],
    pid: null,
    processStartedAt: null,
    rootSessionId: null,
    childSessionIds: [],
    rawLogPath: null,
    summary: null,
    exitCode: 0,
    error: null,
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    completedAt: '2026-07-18T00:00:00.000Z',
  };
}

function learningCandidate(): LearningCandidate {
  return {
    id: 'candidate-1',
    target: 'skill',
    status: 'proposed',
    action: 'patch',
    scope: null,
    key: null,
    value: null,
    skillId: 'runtime-skill',
    repoId: null,
    reason: null,
    reviewId: null,
    patch: null,
    createdAt: '2026-07-18T00:00:00.000Z',
    decidedAt: null,
  };
}

function repoEditEvent(): RepoEditEvent {
  return {
    id: 'event-1',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    sessionId: null,
    workflowRunId: null,
    actorType: 'agent',
    actorId: null,
    action: 'repo_file_replace',
    status: 'applied',
    reason: null,
    paths: ['src/app.ts'],
    inputHash: null,
    diffSummary: null,
    diffPatch: 'patch',
    reviewRevision: resolvedReviewRevision({
      kind: 'retained-patch',
      id: 'patch-sha',
    }),
    error: null,
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
  };
}
