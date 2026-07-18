import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  reviewRevisionKey,
  reviewSourceSchemaVersion,
  type ReviewRevision,
  type ReviewSourceKind,
} from '../shared/review-source';
import { reviewSurfaceSchemaVersion } from '../shared/review-surface';
import { createReviewRefreshStatus } from '../shared/review-refresh';
import {
  ensurePreparedDiffForWorktree,
  readPreparedDiffChangedFiles,
  requestPreparedDiffRevision,
} from './modules/prepared-diffs';
import {
  createDefaultReviewSurfacePromotionTarget,
  type ReviewSurfacePromotionDependencies,
} from './modules/review-surfaces';
import type { ValidatedReviewSurfaceFindingPromotion } from './modules/review-surfaces/registry';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';

const roots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('prepared-diff finding promotion', () => {
  it('rejects a changed worktree revision and reuses the existing transition when the revision matches', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-finding-promotion-'));
    roots.push(home);
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    const now = '2026-07-18T12:00:00.000Z';
    const worktreePath = join(home, 'worktree');
    await mkdir(worktreePath, { recursive: true });
    await runGit(worktreePath, ['init', '--initial-branch=main']);
    await writeFile(
      join(worktreePath, 'example.ts'),
      'const anchor = true;\nconst value = "base";\n',
    );
    await runGit(worktreePath, ['add', 'example.ts']);
    await runGit(worktreePath, [
      '-c',
      'user.name=Neondeck Test',
      '-c',
      'user.email=neondeck@example.invalid',
      'commit',
      '-m',
      'base',
    ]);
    const database = new DatabaseSync(paths.neondeckDatabase);
    database
      .prepare(
        `INSERT INTO worktrees (
          id, repo_id, repo_full_name, github_owner, github_name, pr_number,
          base_ref, head_ref, head_sha, local_path, storage_kind,
          lifecycle_status, direct_push_allowed, adopted, created_by,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      )
      .run(
        'worktree-1',
        'repo-1',
        'example/repo',
        'example',
        'repo',
        42,
        'main',
        'feature',
        'head-sha',
        worktreePath,
        'neondeck-home',
        'prepared-diff',
        0,
        0,
        'test',
        now,
        now,
      );
    database.close();
    const prepared = await ensurePreparedDiffForWorktree(
      {
        id: 'worktree-1',
        repoId: 'repo-1',
        repoFullName: 'example/repo',
        prNumber: 42,
        localPath: worktreePath,
        baseRef: 'main',
        headRef: 'feature',
        headSha: 'head-sha',
        lifecycleStatus: 'prepared-diff',
      },
      paths,
    );
    await writeFile(
      join(worktreePath, 'example.ts'),
      'const anchor = true;\nconst value = "first finding revision";\n',
    );
    const findingRevision = await readPreparedDiffChangedFiles(
      { preparedDiffId: prepared.id },
      paths,
    );
    expect(findingRevision.ok).toBe(true);
    const findingRevisionKey = findingRevision.revision
      ? reviewRevisionKey(findingRevision.revision)
      : null;
    expect(findingRevisionKey).toBeTruthy();
    const findingPromotion = {
      sourceFindingId: 'neon_surface_1234',
      surfaceId: 'review-surface:prepared',
      sourceId: `prepared-diff:${prepared.id}`,
      revisionKey: findingRevisionKey!,
      findingId: 'finding-1',
    };
    const input = {
      preparedDiffId: prepared.id,
      reason: 'Guard the optional value.\n\nNeon provenance: run run-1.',
      approverSurface: 'review-surface:prepared',
      findingPromotion,
    };

    await writeFile(
      join(worktreePath, 'example.ts'),
      'const anchor = true;\nconst value = "new revision, same anchor line";\n',
    );
    const stale = await requestPreparedDiffRevision(input, paths);
    expect(stale).toMatchObject({
      ok: false,
      changed: false,
      error: { code: 'PREPARED_DIFF_STALE_REVISION' },
    });
    expect(stale.message).toContain('Refresh the diff');
    expect(readPreparedStatus(paths, prepared.id)).toBe('prepared');

    const currentRevision = await readPreparedDiffChangedFiles(
      { preparedDiffId: prepared.id },
      paths,
    );
    const currentRevisionKey = currentRevision.revision
      ? reviewRevisionKey(currentRevision.revision)
      : null;
    expect(currentRevisionKey).toBeTruthy();
    const requestRevision = vi.fn<
      NonNullable<ReviewSurfacePromotionDependencies['requestPreparedRevision']>
    >(async () => ({
      ok: true,
      action: 'prepared_diff_request_revision',
      changed: true,
      message: 'recorded',
      preparedDiff: prepared,
      approvals: [
        {
          id: 'revision-approval',
          preparedDiffId: prepared.id,
          worktreeId: prepared.worktreeId,
          approvalType: 'revision',
          status: 'rejected',
          targetSha: null,
          policyHash: null,
          policyDecision: null,
          reason: null,
          approverSurface: null,
          requestedAt: now,
          resolvedAt: now,
          updatedAt: now,
        },
      ],
    }));
    const promote = createDefaultReviewSurfacePromotionTarget(paths, {
      requestPreparedRevision: requestRevision,
    });
    for (const sourceKind of ['prepared-diff', 'kilo-result'] as const) {
      await expect(
        promote(
          promotionCandidate({
            sourceKind,
            preparedDiffId: prepared.id,
            revision: currentRevision.revision!,
            revisionKey: currentRevisionKey!,
          }),
        ),
      ).resolves.toMatchObject({
        ok: true,
        promotion: { targetId: 'revision-approval' },
      });
    }
    expect(requestRevision).toHaveBeenCalledTimes(2);
    const currentFindingPromotion = {
      ...findingPromotion,
      revisionKey: currentRevisionKey!,
    };
    const currentInput = {
      ...input,
      findingPromotion: currentFindingPromotion,
    };
    const first = await requestPreparedDiffRevision(currentInput, paths);
    const retry = await requestPreparedDiffRevision(currentInput, paths);

    expect(first).toMatchObject({
      ok: true,
      changed: true,
      preparedDiff: {
        status: 'revision-requested',
        summary: {
          revisionReason: expect.stringContaining('Neon provenance'),
          findingPromotion: currentFindingPromotion,
        },
      },
      approvals: [{ approvalType: 'revision', status: 'rejected' }],
    });
    expect(retry).toMatchObject({
      ok: true,
      changed: false,
      preparedDiff: { status: 'revision-requested' },
      approvals: [{ approvalType: 'revision' }],
    });
    expect(retry.approvals).toHaveLength(1);
  });
});

function promotionCandidate(input: {
  sourceKind: Extract<ReviewSourceKind, 'prepared-diff' | 'kilo-result'>;
  preparedDiffId: string;
  revision: ReviewRevision;
  revisionKey: string;
}): ValidatedReviewSurfaceFindingPromotion {
  const sourceId =
    input.sourceKind === 'prepared-diff'
      ? `prepared-diff:${input.preparedDiffId}`
      : 'kilo-result:task-1';
  const surfaceId = `surface:${input.sourceKind}`;
  const finding = {
    schemaVersion: 2 as const,
    id: `finding:${input.sourceKind}`,
    surfaceId,
    sourceId,
    revisionKey: input.revisionKey,
    file: 'example.ts',
    anchor: {
      kind: 'line-range' as const,
      side: 'additions' as const,
      startLine: 2,
      endLine: 2,
    },
    title: 'Keep the current anchor',
    explanation: 'The finding must be validated against its own revision.',
    severity: 'major' as const,
    confidence: 'high' as const,
    suggestedAction: null,
    provenance: {
      authorRole: 'display-assistant',
      model: 'openai/gpt-5.6',
      workflowRunId: 'run-1',
      createdAt: '2026-07-18T12:00:00.000Z',
    },
    lifecycle: {
      state: 'active' as const,
      changedAt: '2026-07-18T12:00:00.000Z',
      reason: null,
      promotion: null,
    },
  };
  return {
    surface: {
      schemaVersion: reviewSurfaceSchemaVersion,
      surfaceId,
      source: {
        schemaVersion: reviewSourceSchemaVersion,
        id: sourceId,
        kind: input.sourceKind,
        title: 'Prepared promotion fixture',
        revision: input.revision,
        repository: {
          repoId: 'repo-1',
          repoFullName: 'example/repo',
          worktreeId: 'worktree-1',
          localPath: null,
          localAccess: true,
        },
        files: [
          {
            path: 'example.ts',
            previousPath: null,
            status: 'modified',
            additions: 1,
            deletions: 1,
            generatedLike: false,
            patchState: 'available',
            patchMessage: null,
          },
        ],
        capabilities: ['request-revision', 'refresh'],
        promotionTargets: [
          {
            destination: 'prepared-diff-revision',
            preparedDiffId: input.preparedDiffId,
          },
        ],
        externalUrl: null,
      },
      activePath: 'example.ts',
      selection: null,
      selectedAnnotationId: finding.id,
      fileFilter: null,
      reviewOrder: ['example.ts'],
      viewMode: 'file',
      presentationMode: 'unified',
      annotationVisibility: ['findings'],
      refresh: createReviewRefreshStatus({
        appliedRevision: input.revision,
      }),
      registeredAt: '2026-07-18T12:00:00.000Z',
      updatedAt: '2026-07-18T12:00:00.000Z',
      expiresAt: '2026-07-18T12:01:00.000Z',
      lastNavigationAck: null,
    },
    finding,
    target: {
      destination: 'prepared-diff-revision',
      preparedDiffId: input.preparedDiffId,
    },
    request: {
      sourceId,
      revisionKey: input.revisionKey,
      findingId: finding.id,
      requestId: `request:${input.sourceKind}`,
      destination: 'prepared-diff-revision',
      anchor: { side: 'additions', startLine: 2, endLine: 2 },
      confirm: true,
      reason: 'Apply the finding.',
    },
  };
}

function readPreparedStatus(
  paths: ReturnType<typeof runtimePaths>,
  id: string,
) {
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare('SELECT status FROM prepared_diffs WHERE id = ?;')
      .get(id) as { status: string };
    return row.status;
  } finally {
    database.close();
  }
}

async function runGit(cwd: string, args: string[]) {
  await execFileAsync('git', args, { cwd });
}
